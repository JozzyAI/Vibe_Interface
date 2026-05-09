import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const overview = await getRemoteApprovalOverview();
    return jsonWithCorrelation(overview, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load remote agent overview" },
      { status: 500 },
      correlationId,
    );
  }
}
