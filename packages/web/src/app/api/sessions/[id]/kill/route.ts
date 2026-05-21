import { type NextRequest } from "next/server";
import { getVISession, upsertVISession } from "@vi/core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { validateIdentifier } from "@/lib/validation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const idErr = validateIdentifier(id, "id");
    if (idErr) return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);

    const session = await getVISession(id);
    if (!session) return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);

    const now = new Date().toISOString();
    const updated = { ...session, status: "killed" as const, updatedAt: now, lastUpdate: "Killed from dashboard" };
    await upsertVISession(updated);
    return jsonWithCorrelation({ ok: true, session: updated }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to kill session" },
      { status: 500 },
      correlationId,
    );
  }
}
