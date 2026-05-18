import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await props.params;
    const { requestRemoteAgentDaemonRestart } = await getRemoteAgentsBackend();
    const result = await requestRemoteAgentDaemonRestart(id);
    return jsonWithCorrelation(result, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to restart machine daemon" },
      { status: 500 },
      correlationId,
    );
  }
}
