import { type NextRequest } from "next/server";
import { getPISession } from "@pi/core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const session = await getPISession(id);
    if (!session) return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);

    // Terminal output capture requires tmux integration — returns empty in standalone mode
    return jsonWithCorrelation({ output: "", sessionId: id }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to get output" },
      { status: 500 },
      correlationId,
    );
  }
}
