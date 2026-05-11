import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { heartbeatRemoteAgent } from "@/lib/remote-agents";
import type { RemoteAgentSessionHistoryItem, RemoteAuthConnectorSummary } from "@/lib/types";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
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
    const agent = await heartbeatRemoteAgent(body);
    // Tell pi-agent to stop cleanly when the user has paused/disabled this machine in PI.
    const shouldStop = agent.connectionState === "disabled";
    return jsonWithCorrelation({ agent, shouldStop }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to heartbeat remote agent" },
      { status: 500 },
      correlationId,
    );
  }
}
