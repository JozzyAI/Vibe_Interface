import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { consumeRemoteEnrollment } from "@/lib/remote-agents";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      code: string;
    };
    const result = await consumeRemoteEnrollment(body);
    return jsonWithCorrelation(result, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to consume enrollment code" },
      { status: 500 },
      correlationId,
    );
  }
}
