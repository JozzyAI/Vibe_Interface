import { type NextRequest } from "next/server";
import { getCorrelationId } from "@/lib/observability";
import { exportRemoteAgentJob } from "@/lib/remote-agents";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const params = await props.params;
    const agentId = request.nextUrl.searchParams.get("agentId") ?? undefined;
    const bundle = await exportRemoteAgentJob({ jobId: params.id, agentId });
    return new Response(bundle.content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${bundle.filename}"`,
        "x-correlation-id": correlationId,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to export remote session" },
      { status: 500, headers: { "x-correlation-id": correlationId } },
    );
  }
}
