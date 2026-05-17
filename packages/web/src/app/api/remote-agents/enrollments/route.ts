import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      displayName: string;
      projectLabel: string;
      toolType: string;
      expiresInMinutes?: number;
    };
    const { createRemoteEnrollment } = await getRemoteAgentsBackend();
    const result = await createRemoteEnrollment(body);
    const { pairCommand, advancedCommand, relayUrl, ...enrollment } = result as typeof result & { pairCommand?: string; advancedCommand?: string; relayUrl?: string };
    return jsonWithCorrelation({ enrollment, pairCommand, advancedCommand, relayUrl }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create enrollment code" },
      { status: 500 },
      correlationId,
    );
  }
}
