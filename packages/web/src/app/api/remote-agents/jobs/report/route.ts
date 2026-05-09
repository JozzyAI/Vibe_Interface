import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { reportRemoteAgentJob } from "@/lib/remote-agents";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      agentId: string;
      jobId: string;
      status: "queued" | "running" | "completed" | "failed";
      pid?: number;
      exitCode?: number;
      tmuxSession?: string;
      logFile?: string;
      logTail?: string;
      providerState?: Awaited<ReturnType<typeof reportRemoteAgentJob>>["providerState"];
      artifactsDir?: string;
      handoffTitle?: string;
      progress?: string;
      todo?: string;
      notes?: string;
      error?: string;
      sentInputIds?: string[];
    };
    const job = await reportRemoteAgentJob(body);
    return jsonWithCorrelation({ job }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to report remote agent job" },
      { status: 500 },
      correlationId,
    );
  }
}
