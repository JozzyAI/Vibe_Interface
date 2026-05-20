import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      agentId?: string;
      ralphEnabled?: boolean;
      autoResumeUsageLimit?: boolean;
      autoRestartCodex?: boolean;
      model?: string | null;
      reasoningEffort?: string | null;
    };
    const { updateRemoteAgentJobSettings } = await getRemoteAgentsBackend();
    const job = await updateRemoteAgentJobSettings({
      jobId: id,
      agentId: body.agentId,
      ralphEnabled: body.ralphEnabled,
      autoResumeUsageLimit: body.autoResumeUsageLimit,
      autoRestartCodex: body.autoRestartCodex,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
    });
    return jsonWithCorrelation({ job }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to update remote session" },
      { status: 500 },
      correlationId,
    );
  }
}
