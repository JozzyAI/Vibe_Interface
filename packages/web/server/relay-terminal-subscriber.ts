/**
 * RelayTerminalSubscriber — dashboard-side terminal relay client.
 *
 * Connects OUTBOUND to the relay server's /pi-agent-relay endpoint as the
 * PI dashboard subscriber.  Exposes the same interface as RemoteTerminalRelay
 * so mux-websocket can use either transport transparently.
 *
 * Flow:
 *   relay:/pi-agent-relay  ←─ pi-agent (agent side)
 *   relay:/pi-agent-relay  ←─ this class (dashboard side)
 *   Relay routes frames bidirectionally, tagging agent→dashboard with agentId
 *   and routing dashboard→agent by stripping agentId before forwarding.
 */

import { WebSocket } from "ws";
import { StringDecoder } from "node:string_decoder";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

interface RelayPeer {
  agentId: string;
  send(msg: object): void;
}

export class RelayTerminalSubscriber {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly sessionToPeerId = new Map<string, string>(); // sessionId → agentId
  private readonly dataCallbacks = new Map<string, Set<(data: string) => void>>();
  private readonly exitCallbacks = new Map<string, Set<(code: number) => void>>();
  private readonly sessionDecoders = new Map<string, StringDecoder>();
  private readonly announceListeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly relayWsUrl: string, // wss://relay.example.com/pi-agent-relay
    private readonly relayToken: string,
  ) {}

  /** Start connecting. Call once after construction. */
  start(): void {
    this.connect();
  }

  /** Stop and permanently close. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, "Subscriber stopped");
  }

  // ── RemoteTerminalRelay-compatible interface ───────────────────────────────

  /** Returns a non-null relay peer handle if the session is known via relay. */
  getRelayForSession(sessionId: string): RelayPeer | null {
    const agentId = this.sessionToPeerId.get(sessionId);
    if (!agentId) return null;
    return {
      agentId,
      send: (msg) => this.sendToDashboard(msg),
    };
  }

  openRemote(sessionId: string, cols: number, rows: number): void {
    const agentId = this.sessionToPeerId.get(sessionId);
    if (!agentId) throw new Error(`No relay agent known for session: ${sessionId}`);
    this.sendToDashboard({ type: "terminal_open", agentId, sessionId, cols, rows });
  }

  writeRemote(sessionId: string, data: string): void {
    const agentId = this.sessionToPeerId.get(sessionId);
    if (!agentId) return;
    this.sendToDashboard({
      type: "terminal_input",
      agentId,
      sessionId,
      data: Buffer.from(data, "utf8").toString("base64"),
    });
  }

  resizeRemote(sessionId: string, cols: number, rows: number): void {
    const agentId = this.sessionToPeerId.get(sessionId);
    if (!agentId) return;
    this.sendToDashboard({ type: "terminal_resize", agentId, sessionId, cols, rows });
  }

  closeRemote(sessionId: string): void {
    const agentId = this.sessionToPeerId.get(sessionId);
    if (!agentId) return;
    this.sendToDashboard({ type: "terminal_close", agentId, sessionId });
  }

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
      if (!this.dataCallbacks.get(sessionId)?.size) this.dataCallbacks.delete(sessionId);
      if (!this.exitCallbacks.get(sessionId)?.size) this.exitCallbacks.delete(sessionId);
    };
  }

  onAnnounce(listener: (sessionId: string) => void): () => void {
    this.announceListeners.add(listener);
    return () => { this.announceListeners.delete(listener); };
  }

  /** handleUpgrade is a no-op — relay subscriber uses outbound connections only. */
  handleUpgrade(_req: IncomingMessage, socket: Socket, _head: Buffer): void {
    socket.destroy();
  }

  get peerCount(): number {
    // Count distinct agentIds we know about via announce
    return new Set(this.sessionToPeerId.values()).size;
  }

  get announcedSessionCount(): number {
    return this.sessionToPeerId.size;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private sendToDashboard(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const url = this.relayWsUrl.endsWith("/pi-agent-relay")
      ? this.relayWsUrl
      : `${this.relayWsUrl.replace(/\/$/, "")}/pi-agent-relay`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "hello",
        kind: "pi",
        token: this.relayToken,
      }));
    });

    ws.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = msg["type"] as string;

      if (!this.connected) {
        if (type === "hello_ack") {
          this.connected = true;
          console.log(`[RelaySubscriber] Connected to relay at ${url}`);
        } else if (type === "hello_error") {
          console.error(`[RelaySubscriber] Auth rejected: ${msg["message"]}`);
          ws.close();
        }
        return;
      }

      this.handleMessage(type, msg);
    });

    ws.on("close", () => {
      this.connected = false;
      this.ws = null;
      if (!this.stopped) {
        console.log("[RelaySubscriber] Disconnected, reconnecting in 5s…");
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    ws.on("error", (err) => {
      console.error("[RelaySubscriber] WebSocket error:", err.message);
    });
  }

  private handleMessage(type: string, msg: Record<string, unknown>): void {
    const agentId = typeof msg["agentId"] === "string" ? msg["agentId"] : null;

    switch (type) {
      case "announce": {
        if (!agentId) return;
        const sessions = Array.isArray(msg["sessions"]) ? (msg["sessions"] as unknown[]) : [];
        for (const s of sessions) {
          if (typeof s === "string" && s) {
            this.sessionToPeerId.set(s, agentId);
            for (const listener of this.announceListeners) {
              try { listener(s); } catch { /* ignore */ }
            }
          }
        }
        console.log(`[RelaySubscriber] ${agentId} announced ${sessions.length} session(s)`);
        break;
      }

      case "terminal_data": {
        const sessionId = typeof msg["sessionId"] === "string" ? msg["sessionId"] : null;
        if (!sessionId) return;
        const cbs = this.dataCallbacks.get(sessionId);
        if (!cbs?.size) return;
        let decoded: string;
        try {
          if (!this.sessionDecoders.has(sessionId)) {
            this.sessionDecoders.set(sessionId, new StringDecoder("utf8"));
          }
          decoded = this.sessionDecoders.get(sessionId)!.write(
            Buffer.from(msg["data"] as string, "base64"),
          );
        } catch { return; }
        for (const cb of cbs) {
          try { cb(decoded); } catch { /* ignore */ }
        }
        break;
      }

      case "terminal_exited": {
        const sessionId = typeof msg["sessionId"] === "string" ? msg["sessionId"] : null;
        if (!sessionId) return;
        const exitCode = typeof msg["exitCode"] === "number" ? msg["exitCode"] : -1;
        const cbs = this.exitCallbacks.get(sessionId);
        if (cbs) {
          for (const cb of cbs) {
            try { cb(exitCode); } catch { /* ignore */ }
          }
        }
        this.sessionToPeerId.delete(sessionId);
        this.sessionDecoders.delete(sessionId);
        break;
      }

      case "agent_disconnected": {
        if (!agentId) return;
        // Fire exit(-1) for all sessions this agent owned
        for (const [sessionId, owner] of this.sessionToPeerId) {
          if (owner !== agentId) continue;
          this.sessionToPeerId.delete(sessionId);
          this.sessionDecoders.delete(sessionId);
          const cbs = this.exitCallbacks.get(sessionId);
          if (cbs) {
            for (const cb of cbs) {
              try { cb(-1); } catch { /* ignore */ }
            }
          }
        }
        console.log(`[RelaySubscriber] Agent disconnected: ${agentId}`);
        break;
      }

      case "pong":
        break;
    }
  }
}
