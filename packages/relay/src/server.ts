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
import { getDb, bootstrapOwner } from "./db.js";
import * as store from "./store.js";
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
  return { type: "error", sentAt: new Date().toISOString(), payload: { code, message } };
}

function httpError(code: string, message: string) {
  return { error: code, message, emittedAt: new Date().toISOString() };
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
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

function dispatchToPeer(
  registry: RelayRegistry,
  type: RelayEnvelope["type"],
  targetPeerId: string,
  payload: unknown,
): RelayDispatchResult {
  const delivered = registry.route({ type, to: targetPeerId, sentAt: new Date().toISOString(), payload });
  return delivered ? { delivered: true, targetPeerId } : { delivered: false, targetPeerId, reason: "target_not_connected" };
}

export function createRelayServer(): RelayServer {
  // Initialize DB and bootstrap owner on startup
  const db = getDb();
  bootstrapOwner(db);

  const registry = new RelayRegistry();
  const tokens = loadRelayTokens();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    // ── Health / presence ──────────────────────────────────────────────────
    if (pathname === "/health") {
      const db2 = getDb();
      const agentCount = (db2.prepare("SELECT COUNT(*) AS cnt FROM agents").get() as { cnt: number }).cnt;
      jsonResponse(res, 200, {
        status: "ok",
        peers: registry.listPeers().length,
        dbAgents: agentCount,
      });
      return;
    }

    if (pathname === "/presence") {
      jsonResponse(res, 200, { peers: registry.listPeers() });
      return;
    }

    // ── Daemon routes (/v1/daemon/*) ───────────────────────────────────────
    // Called by pi-agent. Auth: daemon token.
    if (pathname.startsWith("/v1/daemon/") || pathname.startsWith("/api/remote-agents/enrollments/consume")) {
      const token = extractBearerToken(req.headers.authorization);

      // /api/remote-agents/enrollments/consume is consumed by pi-agent pair command
      // without any auth token (it uses the enrollment code as auth).
      const isConsumeAlias =
        pathname === "/api/remote-agents/enrollments/consume" && req.method === "POST";

      if (!isConsumeAlias) {
        if (!token) {
          jsonResponse(res, 401, httpError("unauthorized", "Missing bearer token."));
          return;
        }
        const authorized = authorizeRelayToken(tokens, token, "daemon");
        if (!authorized) {
          jsonResponse(res, 403, httpError("forbidden", "Invalid daemon token."));
          return;
        }
      }

      try {
        // register
        if (pathname === "/v1/daemon/register" && req.method === "POST") {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const agent = store.registerAgent({
            agentId: typeof body["agentId"] === "string" ? body["agentId"] : undefined,
            displayName: String(body["displayName"] ?? ""),
            projectLabel: String(body["projectLabel"] ?? ""),
            toolType: typeof body["toolType"] === "string" ? body["toolType"] : undefined,
            hostLabel: String(body["hostLabel"] ?? ""),
            repoRoot: typeof body["repoRoot"] === "string" ? body["repoRoot"] : undefined,
            branch: typeof body["branch"] === "string" ? body["branch"] : undefined,
            worktree: typeof body["worktree"] === "string" ? body["worktree"] : undefined,
            stateFile: typeof body["stateFile"] === "string" ? body["stateFile"] : undefined,
            logFile: typeof body["logFile"] === "string" ? body["logFile"] : undefined,
            status: typeof body["status"] === "string" ? body["status"] : undefined,
            connectionState: typeof body["connectionState"] === "string" ? body["connectionState"] : undefined,
            consecutiveFailures: typeof body["consecutiveFailures"] === "number" ? body["consecutiveFailures"] : undefined,
            lastError: typeof body["lastError"] === "string" ? body["lastError"] : undefined,
            nextRetryAt: typeof body["nextRetryAt"] === "string" ? body["nextRetryAt"] : undefined,
            relay: body["relay"] != null && typeof body["relay"] === "object" ? body["relay"] as Record<string, unknown> : undefined,
            sessionHistory: Array.isArray(body["sessionHistory"]) ? body["sessionHistory"] : undefined,
            authConnectors: Array.isArray(body["authConnectors"]) ? body["authConnectors"] : undefined,
          });
          jsonResponse(res, 200, { agent });
          return;
        }

        // heartbeat
        if (pathname === "/v1/daemon/heartbeat" && req.method === "POST") {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const result = store.heartbeatAgent({
            agentId: String(body["agentId"] ?? ""),
            status: typeof body["status"] === "string" ? body["status"] : undefined,
            branch: typeof body["branch"] === "string" ? body["branch"] : undefined,
            worktree: typeof body["worktree"] === "string" ? body["worktree"] : undefined,
            repoRoot: typeof body["repoRoot"] === "string" ? body["repoRoot"] : undefined,
            stateFile: typeof body["stateFile"] === "string" ? body["stateFile"] : undefined,
            logFile: typeof body["logFile"] === "string" ? body["logFile"] : undefined,
            connectionState: typeof body["connectionState"] === "string" ? body["connectionState"] : undefined,
            consecutiveFailures: typeof body["consecutiveFailures"] === "number" ? body["consecutiveFailures"] : undefined,
            lastError: typeof body["lastError"] === "string" ? body["lastError"] : undefined,
            nextRetryAt: typeof body["nextRetryAt"] === "string" ? body["nextRetryAt"] : undefined,
            relay: body["relay"] != null && typeof body["relay"] === "object" ? body["relay"] as Record<string, unknown> : undefined,
            sessionHistory: Array.isArray(body["sessionHistory"]) ? body["sessionHistory"] : undefined,
            authConnectors: Array.isArray(body["authConnectors"]) ? body["authConnectors"] : undefined,
          });
          jsonResponse(res, 200, result);
          return;
        }

        // poll
        const pollMatch = pathname.match(/^\/v1\/daemon\/agents\/([^/]+)\/poll$/);
        if (pollMatch && req.method === "GET") {
          const agentId = decodeURIComponent(pollMatch[1] ?? "");
          const result = store.pollAgent(agentId);
          jsonResponse(res, 200, result);
          return;
        }

        // jobs/report
        if (pathname === "/v1/daemon/jobs/report" && req.method === "POST") {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const job = store.reportJob({
            agentId: String(body["agentId"] ?? ""),
            jobId: String(body["jobId"] ?? ""),
            status: String(body["status"] ?? "running"),
            pid: typeof body["pid"] === "number" ? body["pid"] : undefined,
            tmuxSession: typeof body["tmuxSession"] === "string" ? body["tmuxSession"] : undefined,
            exitCode: typeof body["exitCode"] === "number" ? body["exitCode"] : undefined,
            logFile: typeof body["logFile"] === "string" ? body["logFile"] : undefined,
            logTail: typeof body["logTail"] === "string" ? body["logTail"] : undefined,
            providerState: body["providerState"] !== undefined ? body["providerState"] : undefined,
            artifactsDir: typeof body["artifactsDir"] === "string" ? body["artifactsDir"] : undefined,
            error: typeof body["error"] === "string" ? body["error"] : undefined,
            progress: typeof body["progress"] === "string" ? body["progress"] : undefined,
            todo: typeof body["todo"] === "string" ? body["todo"] : undefined,
            notes: typeof body["notes"] === "string" ? body["notes"] : undefined,
            handoffTitle: typeof body["handoffTitle"] === "string" ? body["handoffTitle"] : undefined,
          });
          jsonResponse(res, 200, { job });
          return;
        }

        // approval requests
        if (pathname === "/v1/daemon/requests" && req.method === "POST") {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const approvalRequest = store.createApprovalRequest({
            agentId: String(body["agentId"] ?? ""),
            parentJobId: typeof body["parentJobId"] === "string" ? body["parentJobId"] : undefined,
            title: String(body["title"] ?? ""),
            message: String(body["message"] ?? ""),
            riskLevel: typeof body["riskLevel"] === "string" ? body["riskLevel"] : undefined,
            command: typeof body["command"] === "string" ? body["command"] : undefined,
            actionKind: typeof body["actionKind"] === "string" ? body["actionKind"] : undefined,
            eventType: typeof body["eventType"] === "string" ? body["eventType"] : undefined,
            primaryAction: typeof body["primaryAction"] === "string" ? body["primaryAction"] : undefined,
          });
          // Push to dashboard if connected
          const agentId = approvalRequest.agentId;
          registry.route({ type: "approval_request", to: "pi-dashboard", sentAt: new Date().toISOString(), from: agentId, payload: approvalRequest });
          jsonResponse(res, 200, { approvalRequest });
          return;
        }

        // enrollment consume (daemon path — called during pi-agent pairing)
        if ((pathname === "/v1/daemon/enrollments/consume" || isConsumeAlias) && req.method === "POST") {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const result = store.consumeEnrollment(String(body["code"] ?? ""));
          jsonResponse(res, 200, result);
          return;
        }

        jsonResponse(res, 404, httpError("not_found", "Unknown daemon endpoint."));
        return;
      } catch (error) {
        jsonResponse(res, error instanceof Error && error.message.startsWith("Unknown") ? 410 : 500, {
          error: error instanceof Error ? error.message : "Daemon request failed",
        });
        return;
      }
    }

    // ── PI / dashboard routes (/v1/pi/*) ───────────────────────────────────
    // Called by dashboard client. Auth: pi token.
    if (pathname.startsWith("/v1/pi/")) {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        jsonResponse(res, 401, httpError("unauthorized", "Missing bearer token."));
        return;
      }
      const authorized = authorizeRelayToken(tokens, token, "pi");
      if (!authorized) {
        jsonResponse(res, 403, httpError("forbidden", "Invalid PI token."));
        return;
      }

      try {
        // overview
        if (pathname === "/v1/pi/overview" && req.method === "GET") {
          jsonResponse(res, 200, store.getOverview());
          return;
        }

        // enrollments list
        if (pathname === "/v1/pi/enrollments" && req.method === "GET") {
          jsonResponse(res, 200, {
            enrollments: store.listActiveEnrollments(),
            recentEnrollments: store.listRecentEnrollments(),
          });
          return;
        }

        // create enrollment
        if (pathname === "/v1/pi/enrollments" && req.method === "POST") {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const result = store.createEnrollmentWithPairCommand({
            displayName: String(body["displayName"] ?? ""),
            projectLabel: String(body["projectLabel"] ?? ""),
            toolType: typeof body["toolType"] === "string" ? body["toolType"] : undefined,
            expiresInMinutes: typeof body["expiresInMinutes"] === "number" ? body["expiresInMinutes"] : 60,
          });
          jsonResponse(res, 200, result);
          return;
        }

        // revoke enrollment
        const revokeMatch = pathname.match(/^\/v1\/pi\/enrollments\/([^/]+)\/revoke$/);
        if (revokeMatch && req.method === "POST") {
          const enrollmentId = decodeURIComponent(revokeMatch[1] ?? "");
          const enrollment = store.revokeEnrollment(enrollmentId);
          jsonResponse(res, 200, { enrollment });
          return;
        }

        // create job
        if (pathname === "/v1/pi/jobs" && req.method === "POST") {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const job = store.createJob({
            agentId: String(body["agentId"] ?? ""),
            title: typeof body["title"] === "string" ? body["title"] : undefined,
            command: Array.isArray(body["command"]) ? body["command"] as string[] : [],
            provider: typeof body["provider"] === "string" ? body["provider"] : undefined,
            cwd: typeof body["cwd"] === "string" ? body["cwd"] : undefined,
            env: body["env"] != null && typeof body["env"] === "object" ? body["env"] as Record<string, string> : undefined,
            model: typeof body["model"] === "string" ? body["model"] : undefined,
            reasoningEffort: typeof body["reasoningEffort"] === "string" ? body["reasoningEffort"] : undefined,
            ralphEnabled: body["ralphEnabled"] === true,
            autoResumeUsageLimit: body["autoResumeUsageLimit"] === true,
            autoRestartCodex: body["autoRestartCodex"] === true,
          });
          // Dispatch to agent if connected
          const dispatch = dispatchToPeer(registry, "job_request", job.agentId, job);
          jsonResponse(res, 200, { job, relayDispatch: dispatch });
          return;
        }

        // archive job
        const archiveMatch = pathname.match(/^\/v1\/pi\/jobs\/([^/]+)\/archive$/);
        if (archiveMatch && req.method === "POST") {
          const jobId = decodeURIComponent(archiveMatch[1] ?? "");
          const body = await readJsonBody(req) as Record<string, unknown>;
          const job = store.archiveJob(jobId, typeof body["agentId"] === "string" ? body["agentId"] : undefined);
          jsonResponse(res, 200, { job });
          return;
        }

        // delete job
        const deleteMatch = pathname.match(/^\/v1\/pi\/jobs\/([^/]+)\/delete$/);
        if (deleteMatch && req.method === "POST") {
          const jobId = decodeURIComponent(deleteMatch[1] ?? "");
          const body = await readJsonBody(req) as Record<string, unknown>;
          const result = store.removeJob(jobId, typeof body["agentId"] === "string" ? body["agentId"] : undefined);
          jsonResponse(res, 200, { removed: true, ...result });
          return;
        }

        // restart job
        const restartMatch = pathname.match(/^\/v1\/pi\/jobs\/([^/]+)\/restart$/);
        if (restartMatch && req.method === "POST") {
          const jobId = decodeURIComponent(restartMatch[1] ?? "");
          const body = await readJsonBody(req) as Record<string, unknown>;
          const job = store.restartJob(jobId, typeof body["agentId"] === "string" ? body["agentId"] : undefined);
          const dispatch = dispatchToPeer(registry, "job_request", job.agentId, job);
          jsonResponse(res, 200, { job, relayDispatch: dispatch });
          return;
        }

        // respond to approval
        const respondMatch = pathname.match(/^\/v1\/pi\/approvals\/([^/]+)\/respond$/);
        if (respondMatch && req.method === "POST") {
          const requestId = decodeURIComponent(respondMatch[1] ?? "");
          const body = await readJsonBody(req) as Record<string, unknown>;
          const approvalRequest = store.respondToApproval(
            requestId,
            String(body["action"] ?? "reject"),
            typeof body["response"] === "string" ? body["response"] : undefined,
          );
          const dispatch = dispatchToPeer(registry, "approval_decision", approvalRequest.agentId, approvalRequest);
          jsonResponse(res, 200, { approvalRequest, relayDispatch: dispatch });
          return;
        }

        // remove agent
        const removeAgentMatch = pathname.match(/^\/v1\/pi\/agents\/([^/]+)\/remove$/);
        if (removeAgentMatch && req.method === "POST") {
          const agentId = decodeURIComponent(removeAgentMatch[1] ?? "");
          store.removeAgent(agentId);
          jsonResponse(res, 200, { removed: true });
          return;
        }

        // reconnect agent (create re-pair enrollment)
        const reconnectMatch = pathname.match(/^\/v1\/pi\/agents\/([^/]+)\/reconnect$/);
        if (reconnectMatch && req.method === "POST") {
          const agentId = decodeURIComponent(reconnectMatch[1] ?? "");
          const result = store.createReconnectEnrollment(agentId);
          jsonResponse(res, 200, result);
          return;
        }

        // restart daemon
        const restartDaemonMatch = pathname.match(/^\/v1\/pi\/agents\/([^/]+)\/restart-daemon$/);
        if (restartDaemonMatch && req.method === "POST") {
          const agentId = decodeURIComponent(restartDaemonMatch[1] ?? "");
          const command = store.requestDaemonRestart(agentId);
          jsonResponse(res, 200, { command });
          return;
        }

        // Existing dispatch routes (kept for compat with dashboard relay-dispatch.ts)
        if (pathname === "/v1/pi/approval-decisions" && req.method === "POST") {
          const body = (await readJsonBody(req)) as { agentId?: string; request?: unknown };
          const agentId = typeof body.agentId === "string" ? body.agentId : null;
          if (!agentId) { jsonResponse(res, 400, httpError("invalid_payload", "Missing agentId.")); return; }
          jsonResponse(res, 200, dispatchToPeer(registry, "approval_decision", agentId, body.request));
          return;
        }

        if (pathname === "/v1/pi/jobs/dispatch" && req.method === "POST") {
          const body = (await readJsonBody(req)) as { agentId?: string; job?: unknown };
          const agentId = typeof body.agentId === "string" ? body.agentId : null;
          if (!agentId) { jsonResponse(res, 400, httpError("invalid_payload", "Missing agentId.")); return; }
          jsonResponse(res, 200, dispatchToPeer(registry, "job_request", agentId, body.job));
          return;
        }

        jsonResponse(res, 404, httpError("not_found", "Unknown PI endpoint."));
        return;
      } catch (error) {
        jsonResponse(res, error instanceof Error && error.message.startsWith("Unknown") ? 404 : 500, {
          error: error instanceof Error ? error.message : "PI request failed",
        });
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // ── WebSocket: general relay (/ws) ─────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  // ── WebSocket: terminal relay (/pi-agent-relay) ────────────────────────────
  const terminalWss = new WebSocketServer({ noServer: true });
  const terminalAgents = new Map<string, WebSocket>();
  let terminalDashboard: WebSocket | null = null;

  function sendToAgent(agentId: string, msg: object): void {
    const agentWs = terminalAgents.get(agentId);
    if (agentWs?.readyState === 1) agentWs.send(JSON.stringify(msg));
  }

  function sendToDashboard(msg: object): void {
    if (terminalDashboard?.readyState === 1) terminalDashboard.send(JSON.stringify(msg));
  }

  terminalWss.on("connection", (socket: WebSocket) => {
    let agentId: string | null = null;
    let isDashboard = false;
    let authed = false;

    socket.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { return; }

      if (!authed) {
        if (msg["type"] !== "hello") { socket.close(4001, "Send hello first"); return; }
        const t = typeof msg["token"] === "string" ? msg["token"] : "";
        const kind = typeof msg["kind"] === "string" ? msg["kind"] : "daemon";
        const authorized = authorizeRelayToken(tokens, t, kind === "pi" ? "pi" : "daemon");
        if (!authorized) {
          socket.send(JSON.stringify({ type: "hello_error", message: "Invalid relay token" }));
          socket.close(4003, "Unauthorized");
          return;
        }
        if (kind === "pi") {
          isDashboard = true;
          if (terminalDashboard && terminalDashboard !== socket) terminalDashboard.close(4002, "Replaced");
          terminalDashboard = socket;
          authed = true;
          socket.send(JSON.stringify({ type: "hello_ack" }));
          for (const id of terminalAgents.keys()) socket.send(JSON.stringify({ type: "agent_connected", agentId: id }));
          console.log("[TerminalRelay] Dashboard subscriber connected");
        } else {
          const rawId = typeof msg["agentId"] === "string" ? msg["agentId"] : "";
          if (!rawId) { socket.send(JSON.stringify({ type: "hello_error", message: "Missing agentId" })); socket.close(4001); return; }
          agentId = rawId;
          const existing = terminalAgents.get(agentId);
          if (existing && existing !== socket) existing.close(4002, "Replaced");
          terminalAgents.set(agentId, socket);
          authed = true;
          socket.send(JSON.stringify({ type: "hello_ack", agentId }));
          sendToDashboard({ type: "agent_connected", agentId });
          console.log(`[TerminalRelay] Agent connected: ${agentId}`);
        }
        return;
      }

      if (isDashboard) {
        const targetId = typeof msg["agentId"] === "string" ? msg["agentId"] : null;
        if (!targetId) return;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { agentId: _drop, ...payload } = msg as { agentId: string } & Record<string, unknown>;
        sendToAgent(targetId, payload);
      } else if (agentId) {
        if (msg["type"] === "ping") { socket.send(JSON.stringify({ type: "pong" })); return; }
        sendToDashboard({ ...msg, agentId });
      }
    });

    socket.on("close", () => {
      if (isDashboard) {
        if (terminalDashboard === socket) terminalDashboard = null;
        console.log("[TerminalRelay] Dashboard subscriber disconnected");
      } else if (agentId) {
        terminalAgents.delete(agentId);
        sendToDashboard({ type: "agent_disconnected", agentId });
        console.log(`[TerminalRelay] Agent disconnected: ${agentId}`);
      }
    });

    socket.on("error", () => {
      if (isDashboard && terminalDashboard === socket) terminalDashboard = null;
      else if (agentId) terminalAgents.delete(agentId);
    });
  });

  // ── General relay WebSocket (/ws) ──────────────────────────────────────────
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
      try { envelope = JSON.parse(raw.toString()) as RelayEnvelope; } catch {
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
          sendJson(socket, makeError("invalid_token", "Relay token is invalid."));
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
          payload: { connectionId, peer, peers: registry.listPeers() },
        };
        sendJson(socket, ack);
        return;
      }

      registry.touch(connectionId, timestamp);

      if (envelope.type === "heartbeat") {
        sendJson(socket, { type: "presence_sync", sentAt: timestamp, payload: { peers: registry.listPeers() } });
        return;
      }

      const routed = registry.route({ ...envelope, from: connection.peer?.peerId ?? envelope.from, sentAt: envelope.sentAt ?? timestamp });
      if (!routed) {
        sendJson(socket, makeError("route_not_found", envelope.to ? `No peer connected for ${envelope.to}.` : "Messages must include a target peer id."));
      }
    });

    socket.on("close", () => registry.unregisterConnection(connectionId));
    socket.on("error", () => registry.unregisterConnection(connectionId));
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "ws://localhost").pathname;
    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => wss.emit("connection", ws, request));
    } else if (pathname === "/pi-agent-relay") {
      terminalWss.handleUpgrade(request, socket, head, (ws: WebSocket) => terminalWss.emit("connection", ws, request));
    } else {
      socket.destroy();
    }
  });

  return {
    httpServer,
    shutdown: async () => {
      for (const client of wss.clients) client.close(1001, "Relay shutting down");
      for (const client of terminalWss.clients) client.close(1001, "Relay shutting down");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => { if (error) reject(error); else resolve(); });
      });
    },
  };
}
