import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
// Daemon route — vi-agent calls relay directly in cloud mode; this stays local-only.
import { pollRemoteAgent } from "@/lib/remote-agents";

const STALE_POLL_AGENT_CACHE_MS = 60_000;
const stalePollAgents = new Map<string, number>();

function isStalePollAgentCached(agentId: string) {
  const cachedAt = stalePollAgents.get(agentId);
  if (!cachedAt) return false;
  if (Date.now() - cachedAt <= STALE_POLL_AGENT_CACHE_MS) return true;
  stalePollAgents.delete(agentId);
  return false;
}

function rememberStalePollAgent(agentId: string) {
  stalePollAgents.set(agentId, Date.now());
}

function stoppedPollPayload(agentId: string, cached = false) {
  const now = new Date().toISOString();
  return {
    agent: {
      agentId,
      name: "Removed agent",
      machineLabel: "unknown",
      provider: "unknown",
      hostId: "unknown",
      status: "disconnected",
      enrolledAt: now,
      lastSeenAt: now,
      metadata: { removed: true, shouldStop: true, cached },
    },
    pendingRequests: [],
    resolvedRequests: [],
    pendingJobs: [],
    jobs: [],
    removedJobIds: [],
    controlCommands: [],
    shouldStop: true,
    ignored: true,
    cached,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  const { id } = await params;

  if (isStalePollAgentCached(id)) {
    return jsonWithCorrelation(stoppedPollPayload(id, true), { status: 410 }, correlationId);
  }

  try {
    const payload = await pollRemoteAgent(id);
    if (payload.agent.connectionState === "disabled") {
      rememberStalePollAgent(id);
      return jsonWithCorrelation({ ...payload, shouldStop: true }, { status: 410 }, correlationId);
    }
    return jsonWithCorrelation(payload, { status: 200 }, correlationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to poll remote agent state";
    if (message.startsWith("Unknown remote agent:")) {
      rememberStalePollAgent(id);
      return jsonWithCorrelation(stoppedPollPayload(id), { status: 410 }, correlationId);
    }

    return jsonWithCorrelation(
      { error: message },
      { status: 500 },
      correlationId,
    );
  }
}
