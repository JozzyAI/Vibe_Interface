import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";
import type { RemoteApprovalOverview } from "@/lib/types";

const OVERVIEW_CACHE_MS = 500;
let cachedOverview: { value: RemoteApprovalOverview; expiresAt: number } | null = null;

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const now = Date.now();
    const overview =
      cachedOverview && cachedOverview.expiresAt > now
        ? cachedOverview.value
        : await getRemoteApprovalOverview().then((value) => {
            cachedOverview = { value, expiresAt: now + OVERVIEW_CACHE_MS };
            return value;
          });
    return jsonWithCorrelation(overview, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load remote agent overview" },
      { status: 500 },
      correlationId,
    );
  }
}
