import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { createRemoteEnrollment } from "@/lib/remote-agents";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      displayName: string;
      projectLabel: string;
      toolType: string;
      expiresInMinutes?: number;
    };
    const enrollment = await createRemoteEnrollment(body);
    return jsonWithCorrelation({ enrollment }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create enrollment code" },
      { status: 500 },
      correlationId,
    );
  }
}
