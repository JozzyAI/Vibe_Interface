import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { createRemoteApprovalRequest } from "@/lib/remote-agents";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      agentId: string;
      parentJobId?: string;
      title: string;
      message: string;
      riskLevel?: "low" | "medium" | "high" | "critical";
      command?: string;
      actionKind?:
        | "github_auth"
        | "codex_update"
        | "install_tool"
        | "open_browser_login"
        | "run_host_setup"
        | "other";
      suggestedCommand?: string;
      helperPrompt?: string;
      eventType?:
        | "command"
        | "network_access"
        | "dependency_install"
        | "git_push"
        | "delete_operation"
        | "plan_approval"
        | "final_approval"
        | "scope_clarification"
        | "example_request"
        | "external_action"
        | "generic";
      primaryAction?: "approve" | "reply";
    };
    const approvalRequest = await createRemoteApprovalRequest(body);
    return jsonWithCorrelation({ approvalRequest }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create remote approval request" },
      { status: 500 },
      correlationId,
    );
  }
}
