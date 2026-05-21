/**
 * Remote terminal relay for vi-agent connections.
 *
 * vi-agent machines connect here via WebSocket (/vi-agent-relay).
 * They authenticate, announce which tmux sessions they can serve,
 * then forward terminal frames in both directions.
 *
 * PI server never touches the remote machine's PTY/tmux directly —
 * it only routes frames between the browser mux and the vi-agent relay.
 *
 * Protocol (vi-agent → PI):
 *   hello        { type, agentId, token }
 *   announce     { type, sessions: string[] }
 *   terminal_data   { type, sessionId, data: string (base64) }
 *   terminal_exited { type, sessionId, exitCode: number }
 *   ping         { type }
 *
 * Protocol (PI → vi-agent):
 *   hello_ack    { type, agentId }
 *   hello_error  { type, message }
 *   terminal_open   { type, sessionId, cols, rows }
 *   terminal_input  { type, sessionId, data: string (base64) }
 *   terminal_resize { type, sessionId, cols, rows }
 *   terminal_close  { type, sessionId }
 *   pong         { type }
 *
 * Auth: reads VI_RELAY_TOKENS env var (same format as relay server).
 * If no tokens configured, accepts all connections (dev mode).
 */

import { WebSocketServer, WebSocket } from "ws";
import { StringDecoder } from "node:string_decoder";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

// ── vi-agent → PI ──────────────────────────────────────────────────────────
type AgentMessage =
  | { type: "hello"; agentId: string; token: string }
  | { type: "announce"; sessions: string[] }
  | { type: "terminal_data"; sessionId: string; data: string }
  | { type: "terminal_exited"; sessionId: string; exitCode: number }
  | { type: "ping" };

// ── PI → vi-agent ──────────────────────────────────────────────────────────
type RelayMessage =
  | { type: "hello_ack"; agentId: string }
  | { type: "hello_error"; message: string }
  | { type: "terminal_open"; sessionId: string; cols: number; rows: number }
  | { type: "terminal_input"; sessionId: string; data: string }
  | { type: "terminal_resize"; sessionId: string; cols: number; rows: number }
  | { type: "terminal_close"; sessionId: string }
  | { type: "pong" };

interface RelayPeer {
  agentId: string;
  send(msg: RelayMessage): void;
}

/**
 * Parse VI_RELAY_TOKENS env var into a Set of valid token strings.
 * Format: "token1:kind1:label1,token2:kind2:label2,..."
 * Returns empty set if not configured (dev mode = no auth required).
 */
function loadAllowedTokens(): Set<string> {
  const raw = (process.env.VI_RELAY_TOKENS ?? "").trim();
  if (!raw) return new Set();
  const tokens = new Set<string>();
  for (const entry of raw.split(",")) {
    const token = entry.trim().split(":")[0] ?? "";
    if (token) tokens.add(token);
  }
  return tokens;
}

/**
 * RemoteTerminalRelay manages WebSocket connections from remote vi-agent machines.
 *
 * Responsibilities:
 *  - Authenticate vi-agent connections
 *  - Track which sessions each vi-agent can serve
 *  - Route terminal_open / terminal_input / terminal_resize / terminal_close to the correct vi-agent
 *  - Deliver terminal_data / terminal_exited back to mux subscribers
 */
export class RemoteTerminalRelay {
  private readonly wss: WebSocketServer;
  private readonly peers = new Map<string, RelayPeer>();        // agentId → peer
  private readonly sessionToPeerId = new Map<string, string>(); // sessionId → agentId
  private readonly dataCallbacks = new Map<string, Set<(data: string) => void>>();
  private readonly exitCallbacks = new Map<string, Set<(code: number) => void>>();
  // Per-session streaming UTF-8 decoder — buffers incomplete multi-byte sequences
  // at 4096-byte PTY read boundaries so they never reach xterm.js as mojibake.
  private readonly sessionDecoders = new Map<string, StringDecoder>();
  private readonly allowedTokens: Set<string>;
  // Listeners notified whenever a vi-agent announces (or re-announces) sessions.
  // Used by the mux to retry pending opens that failed because the relay was not
  // yet connected when the browser first requested the session.
  private readonly announceListeners = new Set<(sessionId: string) => void>();

  constructor() {
    this.allowedTokens = loadAllowedTokens();
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    if (this.allowedTokens.size === 0) {
      console.warn(
        "[RelayServer] VI_RELAY_TOKENS not set — relay accepts any connection (dev mode only)",
      );
    }
  }

  /** Route an HTTP upgrade to this relay's WebSocket server. */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    this.wss.handleUpgrade(request, socket as never, head, (ws) => {
      this.wss.emit("connection", ws, request);
    });
  }

  /**
   * Register a listener that fires each time a session becomes available via
   * a vi-agent announce. Returns an unsubscribe function.
   */
  onAnnounce(listener: (sessionId: string) => void): () => void {
    this.announceListeners.add(listener);
    return () => { this.announceListeners.delete(listener); };
  }

  /** Find the relay peer that announced the given session, or null. */
  getRelayForSession(sessionId: string): RelayPeer | null {
    const agentId = this.sessionToPeerId.get(sessionId);
    if (!agentId) return null;
    return this.peers.get(agentId) ?? null;
  }

  /** Tell vi-agent to open a PTY for this session (first browser open). */
  openRemote(sessionId: string, cols: number, rows: number): void {
    const peer = this.getRelayForSession(sessionId);
    if (!peer) throw new Error(`No relay peer connected for session: ${sessionId}`);
    peer.send({ type: "terminal_open", sessionId, cols, rows });
    console.log(`[RelayServer] Sent terminal_open → ${peer.agentId} session=${sessionId}`);
  }

  /**
   * Forward keyboard input to vi-agent.
   * data is a UTF-8 string from xterm.js; base64-encode the UTF-8 bytes for transport.
   */
  writeRemote(sessionId: string, data: string): void {
    const peer = this.getRelayForSession(sessionId);
    if (!peer) return;
    peer.send({
      type: "terminal_input",
      sessionId,
      data: Buffer.from(data, "utf8").toString("base64"),
    });
  }

  /** Forward a terminal resize to vi-agent. */
  resizeRemote(sessionId: string, cols: number, rows: number): void {
    const peer = this.getRelayForSession(sessionId);
    if (!peer) return;
    peer.send({ type: "terminal_resize", sessionId, cols, rows });
  }

  /** Tell vi-agent the browser closed this terminal. */
  closeRemote(sessionId: string): void {
    const peer = this.getRelayForSession(sessionId);
    if (!peer) return;
    peer.send({ type: "terminal_close", sessionId });
  }

  /**
   * Subscribe to terminal data and exit events from vi-agent.
   * Returns an unsubscribe function.
   * The mux TerminalManager calls this when opening a remote terminal.
   */
  subscribeRemote(
    sessionId: string,
    onData: (data: string) => void,
    onExited: (code: number) => void,
  ): () => void {
    if (!this.dataCallbacks.has(sessionId)) this.dataCallbacks.set(sessionId, new Set());
    if (!this.exitCallbacks.has(sessionId)) this.exitCallbacks.set(sessionId, new Set());

    this.dataCallbacks.get(sessionId)!.add(onData);
    this.exitCallbacks.get(sessionId)!.add(onExited);

    return () => {
      this.dataCallbacks.get(sessionId)?.delete(onData);
      this.exitCallbacks.get(sessionId)?.delete(onExited);
      if (this.dataCallbacks.get(sessionId)?.size === 0) this.dataCallbacks.delete(sessionId);
      if (this.exitCallbacks.get(sessionId)?.size === 0) this.exitCallbacks.delete(sessionId);
    };
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get announcedSessionCount(): number {
    return this.sessionToPeerId.size;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let peer: RelayPeer | null = null;
    let authenticated = false;

    const sendRaw = (msg: RelayMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on("message", (raw: Buffer) => {
      let msg: AgentMessage;
      try {
        msg = JSON.parse(raw.toString("utf8")) as AgentMessage;
      } catch {
        return; // ignore unparseable frames
      }

      // ── Authentication handshake ──────────────────────────────────────────
      if (!authenticated) {
        if (msg.type !== "hello") {
          sendRaw({ type: "hello_error", message: "Send hello first" });
          ws.close(4001, "Protocol error");
          return;
        }

        const { agentId, token } = msg;

        if (!agentId) {
          sendRaw({ type: "hello_error", message: "Missing agentId" });
          ws.close(4001, "Missing agentId");
          return;
        }

        if (this.allowedTokens.size > 0 && !this.allowedTokens.has(token)) {
          sendRaw({ type: "hello_error", message: "Invalid relay token" });
          ws.close(4003, "Unauthorized");
          return;
        }

        peer = { agentId, send: sendRaw };
        this.peers.set(agentId, peer);
        authenticated = true;
        console.log(`[RelayServer] vi-agent connected: ${agentId}`);
        sendRaw({ type: "hello_ack", agentId });
        return;
      }

      if (!peer) return; // should not happen after authenticated = true

      // ── Authenticated message handling ────────────────────────────────────
      switch (msg.type) {

        case "announce": {
          const validSessions: string[] = [];
          for (const sessionId of msg.sessions) {
            if (typeof sessionId === "string" && sessionId.length > 0) {
              this.sessionToPeerId.set(sessionId, peer.agentId);
              validSessions.push(sessionId);
            }
          }
          console.log(
            `[RelayServer] ${peer.agentId} announced ${validSessions.length} session(s):`,
            validSessions,
          );
          // Notify listeners so pending browser opens can be retried now that
          // the relay peer is available for these sessions.
          for (const sessionId of validSessions) {
            for (const listener of this.announceListeners) {
              try { listener(sessionId); } catch { /* ignore listener errors */ }
            }
          }
          break;
        }

        case "terminal_data": {
          const cbs = this.dataCallbacks.get(msg.sessionId);
          if (!cbs?.size) return;

          // Decode base64 PTY bytes → UTF-8 string using a streaming decoder so
          // incomplete multi-byte sequences at 4096-byte read boundaries are
          // buffered rather than replaced with U+FFFD (which caused mojibake).
          let decoded: string;
          try {
            if (!this.sessionDecoders.has(msg.sessionId)) {
              this.sessionDecoders.set(msg.sessionId, new StringDecoder("utf8"));
            }
            decoded = this.sessionDecoders.get(msg.sessionId)!.write(
              Buffer.from(msg.data, "base64"),
            );
          } catch {
            return;
          }

          for (const cb of cbs) {
            try {
              cb(decoded);
            } catch (err) {
              console.error("[RelayServer] Data callback threw:", err);
            }
          }
          break;
        }

        case "terminal_exited": {
          const cbs = this.exitCallbacks.get(msg.sessionId);
          if (cbs) {
            for (const cb of cbs) {
              try {
                cb(msg.exitCode);
              } catch (err) {
                console.error("[RelayServer] Exit callback threw:", err);
              }
            }
          }
          this.sessionToPeerId.delete(msg.sessionId);
          this.sessionDecoders.delete(msg.sessionId);
          console.log(`[RelayServer] Remote terminal exited: ${msg.sessionId} (code ${msg.exitCode})`);
          break;
        }

        case "ping": {
          sendRaw({ type: "pong" });
          break;
        }
      }
    });

    ws.on("close", () => {
      if (!peer) return;
      console.log(`[RelayServer] vi-agent disconnected: ${peer.agentId}`);
      this.peers.delete(peer.agentId);

      // Remove all session claims for this peer and fire exit(-1) for any
      // open terminals so the mux can tell the browser the connection dropped.
      for (const [sessionId, agentId] of this.sessionToPeerId) {
        if (agentId === peer.agentId) {
          this.sessionToPeerId.delete(sessionId);
          const cbs = this.exitCallbacks.get(sessionId);
          if (cbs) {
            for (const cb of cbs) {
              try {
                cb(-1);
              } catch {}
            }
          }
        }
      }
    });

    ws.on("error", (err) => {
      console.error(`[RelayServer] WebSocket error for ${peer?.agentId ?? "(unauthenticated)"}:`, err.message);
    });
  }
}
