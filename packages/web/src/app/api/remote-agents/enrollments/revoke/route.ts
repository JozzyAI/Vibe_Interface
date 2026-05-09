import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { revokeRemoteEnrollment } from "@/lib/remote-agents";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as { enrollmentId: string };
    const enrollment = await revokeRemoteEnrollment(body);
    return jsonWithCorrelation({ enrollment }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to revoke enrollment code" },
      { status: 500 },
      correlationId,
    );
  }
}
