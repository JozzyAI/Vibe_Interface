import { type NextRequest } from "next/server";
import { deletePISession } from "@pi/core";
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

    await deletePISession(id);
    return jsonWithCorrelation({ ok: true }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to delete session" },
      { status: 500 },
      correlationId,
    );
  }
}
