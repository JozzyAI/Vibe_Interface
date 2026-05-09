import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { continueRemoteAgentJobOnMachine } from "@/lib/remote-agents";
import { dispatchRelayJob } from "@/lib/relay-dispatch";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      sourceAgentId?: string;
      targetAgentId?: string;
      cwd?: string;
    };
    if (!body.targetAgentId?.trim()) {
      throw new Error("Choose a target machine for the continuation session");
    }
    const job = await continueRemoteAgentJobOnMachine({
      jobId: id,
      sourceAgentId: body.sourceAgentId,
      targetAgentId: body.targetAgentId,
      cwd: body.cwd,
    });
    const relayDispatch = await dispatchRelayJob(job.agentId, job);
    return jsonWithCorrelation({ job, relayDispatch }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to continue remote session" },
      { status: 500 },
      correlationId,
    );
  }
}
