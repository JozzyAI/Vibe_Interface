import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";
import type { RemoteApprovalOverview } from "@/lib/types";

const OVERVIEW_CACHE_MS = 500;
let cachedOverview: { value: RemoteApprovalOverview; expiresAt: number } | null = null;

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const t0 = Date.now();
  try {
    const now = Date.now();
    const { getRemoteApprovalOverview } = await getRemoteAgentsBackend();
    let cacheHit = false;
    const overview =
      cachedOverview && cachedOverview.expiresAt > now
        ? (cacheHit = true, cachedOverview.value)
        : await getRemoteApprovalOverview().then((value) => {
            cachedOverview = { value, expiresAt: now + OVERVIEW_CACHE_MS };
            return value;
          });
    const elapsed = Date.now() - t0;
    console.log(
      `[overview-route] ${elapsed}ms cache=${cacheHit} agents=${overview.agents.length} jobs=${overview.jobs.length} requests=${overview.requests.length} enrollments=${overview.enrollments.length}`,
    );
    return jsonWithCorrelation(overview, { status: 200 }, correlationId);
  } catch (error) {
    console.log(`[overview-route] ERROR ${Date.now() - t0}ms ${error instanceof Error ? error.message : error}`);
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load remote agent overview" },
      { status: 500 },
      correlationId,
    );
  }
}
