import { type NextRequest } from "next/server";
import { getVISession } from "@vi/core";
import { getServices } from "@/lib/services";
import { validateIdentifier, validateString, stripControlChars } from "@/lib/validation";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

const MAX_MESSAGE_LENGTH = 10_000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const idErr = validateIdentifier(id, "id");
    if (idErr) return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const msgErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
    if (msgErr) return jsonWithCorrelation({ error: msgErr }, { status: 400 }, correlationId);

    const session = await getVISession(id);
    if (!session) return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);

    const { sessionManager } = await getServices();
    await sessionManager.send(id, stripControlChars(body!.message as string));
    return jsonWithCorrelation({ ok: true }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to send message" },
      { status: 500 },
      correlationId,
    );
  }
}
