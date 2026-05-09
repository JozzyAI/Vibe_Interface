import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { WebSocket } from "ws";
import { authorizeRelayToken, loadRelayTokens } from "./auth.js";
import { RelayRegistry, type RelayConnection } from "./routing.js";
import type {
  RelayDispatchResult,
  RelayEnvelope,
  RelayErrorPayload,
  RelayHelloAckPayload,
  RelayHelloPayload,
  RelayPeerRecord,
} from "./types.js";

export interface RelayServer {
  httpServer: HttpServer;
  shutdown: () => Promise<void>;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

function jsonResponse(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendJson(socket: WebSocket, message: RelayEnvelope) {
  socket.send(JSON.stringify(message));
}

function makeError(code: string, message: string): RelayEnvelope<RelayErrorPayload> {
  return {
    type: "error",
    sentAt: new Date().toISOString(),
    payload: { code, message },
  };
}

function httpRelayError(code: string, message: string) {
  return {
    error: code,
    message,
    emittedAt: new Date().toISOString(),
  };
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token.trim();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function getPiBaseUrl(): string | null {
  return process.env.PI_RELAY_PI_BASE_URL?.replace(/\/$/, "") ?? null;
}

async function proxyToPi(pathname: string, method: string, payload?: unknown) {
  const piBaseUrl = getPiBaseUrl();
  if (!piBaseUrl) {
    throw new Error("PI_RELAY_PI_BASE_URL is not configured.");
  }

  const response = await fetch(`${piBaseUrl}${pathname}`, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: unknown }).error ?? "Relay PI proxy failed")
        : `Relay PI proxy failed (${response.status})`;
    throw new Error(message);
  }
  return parsed;
}

function dispatchToPeer(
  registry: RelayRegistry,
  type: RelayEnvelope["type"],
  targetPeerId: string,
  payload: unknown,
): RelayDispatchResult {
  const delivered = registry.route({
    type,
    to: targetPeerId,
    sentAt: new Date().toISOString(),
    payload,
  });

  if (!delivered) {
    return {
      delivered: false,
      targetPeerId,
      reason: "target_not_connected",
    };
  }

  return {
    delivered: true,
    targetPeerId,
  };
}

export function createRelayServer(): RelayServer {
  const registry = new RelayRegistry();
  const tokens = loadRelayTokens();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/v1/daemon/")) {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        jsonResponse(res, 401, httpRelayError("unauthorized", "Missing bearer token."));
        return;
      }

      const authorized = authorizeRelayToken(tokens, token, "daemon");
      if (!authorized) {
        jsonResponse(res, 403, httpRelayError("forbidden", "Relay token is invalid for daemon use."));
        return;
      }

      try {
        if (url.pathname === "/v1/daemon/register" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await proxyToPi("/api/remote-agents/register", "POST", body);
          jsonResponse(res, 200, result);
          return;
        }

        if (url.pathname === "/v1/daemon/heartbeat" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await proxyToPi("/api/remote-agents/heartbeat", "POST", body);
          jsonResponse(res, 200, result);
          return;
        }

        if (url.pathname === "/v1/daemon/requests" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await proxyToPi("/api/remote-agents/requests", "POST", body);
          jsonResponse(res, 200, result);
          return;
        }

        if (url.pathname === "/v1/daemon/jobs/report" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await proxyToPi("/api/remote-agents/jobs/report", "POST", body);
          jsonResponse(res, 200, result);
          return;
        }

        const pollMatch = url.pathname.match(/^\/v1\/daemon\/agents\/([^/]+)\/poll$/);
        if (pollMatch && req.method === "GET") {
          const agentId = encodeURIComponent(decodeURIComponent(pollMatch[1] ?? ""));
          const result = await proxyToPi(`/api/remote-agents/agents/${agentId}/poll`, "GET");
          jsonResponse(res, 200, result);
          return;
        }

        jsonResponse(res, 404, httpRelayError("not_found", "Unknown relay daemon endpoint."));
        return;
      } catch (error) {
        jsonResponse(
          res,
          502,
          httpRelayError(
            "pi_proxy_failed",
            error instanceof Error ? error.message : "Relay failed to proxy the daemon request to PI.",
          ),
        );
        return;
      }
    }

    if (url.pathname.startsWith("/v1/pi/")) {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        jsonResponse(res, 401, httpRelayError("unauthorized", "Missing bearer token."));
        return;
      }

      const authorized = authorizeRelayToken(tokens, token, "pi");
      if (!authorized) {
        jsonResponse(res, 403, httpRelayError("forbidden", "Relay token is invalid for PI use."));
        return;
      }

      try {
        if (url.pathname === "/v1/pi/approval-decisions" && req.method === "POST") {
          const body = (await readJsonBody(req)) as {
            agentId?: string;
            request?: unknown;
          };
          const agentId = typeof body.agentId === "string" ? body.agentId : null;
          if (!agentId) {
            jsonResponse(res, 400, httpRelayError("invalid_payload", "Missing agentId."));
            return;
          }
          jsonResponse(res, 200, dispatchToPeer(registry, "approval_decision", agentId, body.request));
          return;
        }

        if (url.pathname === "/v1/pi/jobs/dispatch" && req.method === "POST") {
          const body = (await readJsonBody(req)) as {
            agentId?: string;
            job?: unknown;
          };
          const agentId = typeof body.agentId === "string" ? body.agentId : null;
          if (!agentId) {
            jsonResponse(res, 400, httpRelayError("invalid_payload", "Missing agentId."));
            return;
          }
          jsonResponse(res, 200, dispatchToPeer(registry, "job_request", agentId, body.job));
          return;
        }

        jsonResponse(res, 404, httpRelayError("not_found", "Unknown relay PI endpoint."));
        return;
      } catch (error) {
        jsonResponse(
          res,
          502,
          httpRelayError(
            "relay_dispatch_failed",
            error instanceof Error ? error.message : "Relay failed to dispatch the PI message.",
          ),
        );
        return;
      }
    }

    if (url.pathname === "/health") {
      jsonResponse(res, 200, {
        status: "ok",
        peers: registry.listPeers().length,
      });
      return;
    }

    if (url.pathname === "/presence") {
      jsonResponse(res, 200, {
        peers: registry.listPeers(),
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "ws://localhost").pathname;
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    const connectionId = randomUUID();
    let authenticated = false;

    const connection: RelayConnection = {
      connectionId,
      send: (message) => sendJson(socket, message),
      close: (code, reason) => socket.close(code, reason),
    };

    registry.registerConnection(connection);

    socket.on("message", (raw: Buffer) => {
      let envelope: RelayEnvelope;
      try {
        envelope = JSON.parse(raw.toString()) as RelayEnvelope;
      } catch {
        sendJson(socket, makeError("invalid_json", "Relay expected JSON messages."));
        return;
      }

      const timestamp = new Date().toISOString();

      if (!authenticated) {
        if (envelope.type !== "hello") {
          sendJson(socket, makeError("unauthenticated", "Send a hello envelope first."));
          return;
        }

        const payload = envelope.payload as RelayHelloPayload | undefined;
        if (!payload?.peerId || !payload?.kind || !payload?.token) {
          sendJson(socket, makeError("invalid_hello", "Hello payload is missing required fields."));
          return;
        }

        const authorized = authorizeRelayToken(tokens, payload.token, payload.kind);
        if (!authorized) {
          sendJson(socket, makeError("invalid_token", "Relay token is invalid for this peer kind."));
          socket.close(4001, "Invalid relay token");
          return;
        }

        const peer: RelayPeerRecord = {
          peerId: payload.peerId,
          kind: payload.kind,
          label: payload.label || authorized.label,
          connectedAt: timestamp,
          lastSeenAt: timestamp,
          connectionId,
        };

        registry.attachPeer(connectionId, peer);
        authenticated = true;

        const ack: RelayEnvelope<RelayHelloAckPayload> = {
          type: "hello_ack",
          sentAt: timestamp,
          payload: {
            connectionId,
            peer,
            peers: registry.listPeers(),
          },
        };
        sendJson(socket, ack);
        return;
      }

      registry.touch(connectionId, timestamp);

      if (envelope.type === "heartbeat") {
        sendJson(socket, {
          type: "presence_sync",
          sentAt: timestamp,
          payload: {
            peers: registry.listPeers(),
          },
        });
        return;
      }

      const routed = registry.route({
        ...envelope,
        from: connection.peer?.peerId ?? envelope.from,
        sentAt: envelope.sentAt ?? timestamp,
      });

      if (!routed) {
        sendJson(
          socket,
          makeError(
            "route_not_found",
            envelope.to
              ? `No relay peer is currently connected for target ${envelope.to}.`
              : "Relay messages must include a target peer id in `to`.",
          ),
        );
      }
    });

    socket.on("close", () => {
      registry.unregisterConnection(connectionId);
    });

    socket.on("error", () => {
      registry.unregisterConnection(connectionId);
    });
  });

  return {
    httpServer,
    shutdown: async () => {
      for (const client of wss.clients) {
        client.close(1001, "Relay shutting down");
      }

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
