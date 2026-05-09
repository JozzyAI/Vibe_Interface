import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { updateRemoteAgentDetails } from "@/lib/remote-agents";

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const params = await props.params;
    const body = (await request.json()) as {
      displayName?: string;
      projectLabel?: string;
    };
    const agent = await updateRemoteAgentDetails({
      agentId: params.id,
      displayName: body.displayName,
      projectLabel: body.projectLabel,
    });
    return jsonWithCorrelation({ agent }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to update machine" },
      { status: 500 },
      correlationId,
    );
  }
}
