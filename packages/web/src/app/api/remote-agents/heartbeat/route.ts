import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
// Daemon route — pi-agent calls relay directly in cloud mode; this stays local-only.
import { heartbeatRemoteAgent } from "@/lib/remote-agents";
import type { RemoteAgentSessionHistoryItem, RemoteAuthConnectorSummary } from "@/lib/types";

const STALE_HEARTBEAT_CACHE_MS = 60_000;
const HEARTBEAT_DEDUPE_CACHE_MS = 2_000;
const staleHeartbeatAgents = new Map<string, number>();
const recentHeartbeatResponses = new Map<string, { signature: string; until: number; body: unknown }>();

function isStaleHeartbeatCached(agentId: string) {
  const staleUntil = staleHeartbeatAgents.get(agentId);
  if (!staleUntil) {
    return false;
  }
  if (staleUntil <= Date.now()) {
    staleHeartbeatAgents.delete(agentId);
    return false;
  }
  return true;
}

function rememberStaleHeartbeat(agentId: string) {
  staleHeartbeatAgents.set(agentId, Date.now() + STALE_HEARTBEAT_CACHE_MS);
}

function heartbeatSignature(body: { authConnectors?: RemoteAuthConnectorSummary[]; [key: string]: unknown }) {
  return JSON.stringify({
    ...body,
    authConnectors: body.authConnectors?.map(({ checkedAt: _checkedAt, ...connector }) => connector),
  });
}

function getRecentHeartbeat(agentId: string, signature: string) {
  const cached = recentHeartbeatResponses.get(agentId);
  if (!cached) {
    return null;
  }
  if (cached.until <= Date.now() || cached.signature !== signature) {
    recentHeartbeatResponses.delete(agentId);
    return null;
  }
  return cached.body;
}

function rememberRecentHeartbeat(agentId: string, signature: string, body: unknown) {
  recentHeartbeatResponses.set(agentId, {
    signature,
    until: Date.now() + HEARTBEAT_DEDUPE_CACHE_MS,
    body,
  });
}

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  let agentId: string | null = null;
  try {
    const body = (await request.json()) as {
      agentId: string;
      status?: "running" | "awaiting_approval" | "awaiting_input" | "completed" | "failed" | "paused";
      branch?: string;
      worktree?: string;
      repoRoot?: string;
      stateFile?: string;
      logFile?: string;
      connectionState?: "connected" | "stale" | "disconnected";
      consecutiveFailures?: number;
      lastError?: string;
      nextRetryAt?: string;
      relay?: {
        url?: string;
        peerId?: string;
        connected: boolean;
        lastHelloAt?: string;
        lastHeartbeatAt?: string;
        lastError?: string;
      };
      sessionHistory?: RemoteAgentSessionHistoryItem[];
      authConnectors?: RemoteAuthConnectorSummary[];
    };
    agentId = body.agentId;
    if (isStaleHeartbeatCached(agentId)) {
      return jsonWithCorrelation({ agent: null, shouldStop: true, cached: true }, { status: 410 }, correlationId);
    }
    const signature = heartbeatSignature(body);
    const recent = getRecentHeartbeat(agentId, signature);
    if (recent) {
      return jsonWithCorrelation({ ...(recent as object), cached: true }, { status: 200 }, correlationId);
    }
    const agent = await heartbeatRemoteAgent(body);
    // Removed machines should get a hard Gone response so stale daemons stop
    // instead of re-registering and replaying old jobs forever.
    if (agent.connectionState === "disabled") {
      rememberStaleHeartbeat(agentId);
      return jsonWithCorrelation({ agent, shouldStop: true }, { status: 410 }, correlationId);
    }
    const responseBody = { agent, shouldStop: false };
    rememberRecentHeartbeat(agentId, signature, responseBody);
    return jsonWithCorrelation(responseBody, { status: 200 }, correlationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to heartbeat remote agent";
    if (message.startsWith("Unknown remote agent:")) {
      if (agentId) {
        rememberStaleHeartbeat(agentId);
      }
      return jsonWithCorrelation({ agent: null, shouldStop: true, error: message }, { status: 410 }, correlationId);
    }
    return jsonWithCorrelation(
      { error: message },
      { status: 500 },
      correlationId,
    );
  }
}
