import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { restartRemoteCodexJob } from "@/lib/remote-agents";
import { dispatchRelayJob } from "@/lib/relay-dispatch";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { agentId?: string };
    const job = await restartRemoteCodexJob({
      jobId: id,
      agentId: body.agentId,
    });
    const relayDispatch = await dispatchRelayJob(job.agentId, job);
    return jsonWithCorrelation({ job, relayDispatch }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to restart remote session" },
      { status: 500 },
      correlationId,
    );
  }
}
