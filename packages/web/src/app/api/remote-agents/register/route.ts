import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
// Daemon route — pi-agent calls relay directly in cloud mode; this stays local-only.
import { registerRemoteAgent } from "@/lib/remote-agents";
import type { RemoteAgentSessionHistoryItem, RemoteAuthConnectorSummary } from "@/lib/types";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      agentId?: string;
      displayName: string;
      projectLabel: string;
      toolType: string;
      hostLabel: string;
      repoRoot?: string;
      branch?: string;
      worktree?: string;
      stateFile?: string;
      logFile?: string;
      status?: "running" | "awaiting_approval" | "awaiting_input" | "completed" | "failed" | "paused";
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
    const agent = await registerRemoteAgent(body);
    return jsonWithCorrelation({ agent }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to register remote agent" },
      { status: 500 },
      correlationId,
    );
  }
}
