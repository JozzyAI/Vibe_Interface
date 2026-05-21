import { type NextRequest } from "next/server";
import { getVISession, deriveVISessionState } from "@vi/core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { validateIdentifier } from "@/lib/validation";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const idErr = validateIdentifier(id, "id");
    if (idErr) return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);

    const session = await getVISession(id);
    if (!session) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    return jsonWithCorrelation(
      { session: { ...session, piState: deriveVISessionState(session) } },
      { status: 200 },
      correlationId,
    );
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to get session" },
      { status: 500 },
      correlationId,
    );
  }
}
