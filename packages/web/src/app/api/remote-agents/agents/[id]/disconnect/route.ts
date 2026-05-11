import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { disableRemoteAgent } from "@/lib/remote-agents";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await props.params;
    const agent = await disableRemoteAgent(id);
    return jsonWithCorrelation({ agent }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to disconnect machine" },
      { status: 500 },
      correlationId,
    );
  }
}
