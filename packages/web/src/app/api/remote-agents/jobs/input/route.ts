import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { queueRemoteAgentJobInput } from "@/lib/remote-agents";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      agentId: string;
      jobId: string;
      text?: string;
      submit?: boolean;
      key?: "escape";
    };
    const job = await queueRemoteAgentJobInput({
      agentId: body.agentId,
      jobId: body.jobId,
      text: body.text ?? "",
      submit: body.submit ?? true,
      key: body.key,
    });
    return jsonWithCorrelation({ job }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to send remote input" },
      { status: 500 },
      correlationId,
    );
  }
}
