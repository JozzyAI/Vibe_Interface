import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      agentId: string;
      mode?: "manual" | "timeout_allow" | "always_allow";
      cycle?: boolean;
      timeoutSeconds?: number;
    };
    const { setRemoteAgentPolicy } = await getRemoteAgentsBackend();
    const agent = await setRemoteAgentPolicy(body);
    return jsonWithCorrelation({ agent }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to update remote agent policy" },
      { status: 500 },
      correlationId,
    );
  }
}
