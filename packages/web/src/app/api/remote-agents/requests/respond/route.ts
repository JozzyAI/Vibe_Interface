import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";
import { dispatchRelayApprovalDecision } from "@/lib/relay-dispatch";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      requestId: string;
      action: "approve" | "reject";
      response?: string;
    };
    const { respondToRemoteApproval } = await getRemoteAgentsBackend();
    const approvalRequest = await respondToRemoteApproval(body);
    const relayDispatch = await dispatchRelayApprovalDecision(approvalRequest.agentId, approvalRequest);
    return jsonWithCorrelation({ approvalRequest, relayDispatch }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to respond to remote approval request" },
      { status: 500 },
      correlationId,
    );
  }
}
