/**
 * Direct WebSocket terminal server.
 * Hosts the multiplexed /mux WebSocket endpoint for all terminal connections.
 */

import { createServer, type Server } from "node:http";
import type { WebSocketServer } from "ws";
import { findTmux } from "./tmux-utils.js";
import { createMuxWebSocket } from "./mux-websocket.js";
import { RemoteTerminalRelay } from "./remote-terminal-relay.js";
import { RelayTerminalSubscriber } from "./relay-terminal-subscriber.js";

export type TerminalRelay = RemoteTerminalRelay | RelayTerminalSubscriber;

export interface DirectTerminalServer {
  server: Server;
  relay: TerminalRelay;
  shutdown: () => void;
}

function buildTerminalRelay(): TerminalRelay {
  const relayBase = (
    process.env.PI_RELAY_BASE_URL ?? process.env.PI_RELAY_URL ?? ""
  ).trim().replace(/\/$/, "");
  const relayToken = (process.env.PI_RELAY_PI_TOKEN ?? "").trim();

  if (relayBase && relayToken) {
    const wsBase = relayBase.startsWith("http://")
      ? "ws://" + relayBase.slice("http://".length)
      : relayBase.startsWith("https://")
        ? "wss://" + relayBase.slice("https://".length)
        : relayBase;
    const url = `${wsBase}/pi-agent-relay`;
    console.log(`[DirectTerminal] Using relay terminal subscriber: ${url}`);
    const sub = new RelayTerminalSubscriber(url, relayToken);
    sub.start();
    return sub;
  }

  return new RemoteTerminalRelay();
}

/**
 * Create the direct terminal WebSocket server.
 * Hosts two WebSocket paths:
 *   /mux           — browser-facing mux (xterm.js DirectTerminal)
 *   /pi-agent-relay — pi-agent relay connections for remote terminals
 *
 * Separated from listen() so tests can control lifecycle.
 */
export function createDirectTerminalServer(tmuxPath?: string): DirectTerminalServer {
  const TMUX = tmuxPath ?? findTmux();

  // Relay must be created before the mux so the mux can use it for remote fallback
  const relay = buildTerminalRelay();

  let muxWss: WebSocketServer | null = null;

  const metrics = {
    totalConnections: 0,
    totalDisconnects: 0,
    totalErrors: 0,
  };

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          mux: { clients: muxWss?.clients.size ?? 0, metrics },
          relay: {
            peers: relay.peerCount,
            sessions: relay.announcedSessionCount,
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  muxWss = createMuxWebSocket(TMUX, relay);

  if (muxWss) {
    muxWss.on("connection", (ws) => {
      metrics.totalConnections++;
      ws.on("close", () => {
        metrics.totalDisconnects++;
      });
      ws.on("error", () => {
        metrics.totalErrors++;
      });
    });
  }

  // Manual upgrade routing — ws library doesn't support multiple WebSocketServer
  // instances with different `path` options on the same HTTP server.
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "ws://localhost").pathname;

    if (pathname === "/mux" && muxWss) {
      muxWss.handleUpgrade(request, socket, head, (ws) => {
        muxWss!.emit("connection", ws, request);
      });
    } else if (pathname === "/pi-agent-relay" && relay instanceof RemoteTerminalRelay) {
      relay.handleUpgrade(request, socket as never, head);
    } else {
      socket.destroy();
    }
  });

  function shutdown() {
    // Terminate all connected mux clients — this triggers their 'close' events
    // which unsubscribe terminal callbacks and kill PTY processes.
    if (muxWss) {
      for (const client of muxWss.clients) {
        client.terminate();
      }
      muxWss.close();
    }
    server.close();
  }

  return { server, relay, shutdown };
}

// --- Run as standalone script ---
// Only start the server when executed directly (not imported by tests)
const isMainModule =
  process.argv[1]?.endsWith("direct-terminal-ws.ts") ||
  process.argv[1]?.endsWith("direct-terminal-ws.js");

if (isMainModule) {
  const TMUX = findTmux();
  console.log(`[DirectTerminal] Using tmux: ${TMUX}`);

  const { server, shutdown } = createDirectTerminalServer(TMUX);
  const PORT = parseInt(process.env.DIRECT_TERMINAL_PORT ?? "14801", 10);

  server.listen(PORT, () => {
    console.log(`[DirectTerminal] WebSocket server listening on port ${PORT}`);
  });

  function handleShutdown(signal: string) {
    console.log(`[DirectTerminal] Received ${signal}, shutting down...`);
    shutdown();
    const forceExitTimer = setTimeout(() => {
      console.error("[DirectTerminal] Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();
  }

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}
