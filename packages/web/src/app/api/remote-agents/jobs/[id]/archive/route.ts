import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { archiveRemoteAgentJob } from "@/lib/remote-agents";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const params = await props.params;
    const body = (await request.json().catch(() => ({}))) as { agentId?: string };
    const job = await archiveRemoteAgentJob({ jobId: params.id, agentId: body.agentId });
    return jsonWithCorrelation({ job }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to archive remote session" },
      { status: 500 },
      correlationId,
    );
  }
}
