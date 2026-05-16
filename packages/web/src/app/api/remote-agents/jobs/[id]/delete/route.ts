import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const params = await props.params;
    const body = (await request.json().catch(() => ({}))) as { agentId?: string };
    const { removeRemoteAgentJob } = await getRemoteAgentsBackend();
    const result = await removeRemoteAgentJob({ jobId: params.id, agentId: body.agentId });
    return jsonWithCorrelation({ removed: true, ...result }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to remove remote session" },
      { status: 500 },
      correlationId,
    );
  }
}
