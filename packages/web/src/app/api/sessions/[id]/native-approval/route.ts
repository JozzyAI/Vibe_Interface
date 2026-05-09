import { type NextRequest } from "next/server";
import { getPISession } from "@pi/core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { parseNativeCodexApproval } from "@/lib/native-codex-approval";

// Stub: terminal capture not available in standalone PI (no tmux dependency)
async function captureTerminalOutput(_tmuxName: string): Promise<string> {
  return "";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const session = await getPISession(id);
    if (!session) return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);

    const tmuxName = session.metadata["tmuxName"] ?? session.metadata["host"] ?? session.id;
    const output = await captureTerminalOutput(tmuxName);
    const approval = parseNativeCodexApproval(output);
    return jsonWithCorrelation({ approval }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to get approval state" },
      { status: 500 },
      correlationId,
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const session = await getPISession(id);
    if (!session) return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);

    const body = (await request.json().catch(() => ({}))) as { decision?: string };
    return jsonWithCorrelation({ ok: true, decision: body.decision ?? "approved", sessionId: id }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to submit approval" },
      { status: 500 },
      correlationId,
    );
  }
}
