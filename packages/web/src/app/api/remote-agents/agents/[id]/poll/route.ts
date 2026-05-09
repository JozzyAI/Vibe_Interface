import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { pollRemoteAgent } from "@/lib/remote-agents";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const payload = await pollRemoteAgent(id);
    return jsonWithCorrelation(payload, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to poll remote agent state" },
      { status: 500 },
      correlationId,
    );
  }
}
