import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";
import type { RemoteApprovalOverview } from "@/lib/types";

// 2s coalescing window — long enough to absorb concurrent pollers, short enough to feel live
const OVERVIEW_CACHE_MS = 2_000;
let cachedOverview: { value: RemoteApprovalOverview; expiresAt: number } | null = null;
// Deduplicate concurrent in-flight requests (thundering herd guard)
let inFlight: Promise<RemoteApprovalOverview> | null = null;

// Warm the relay connection + cache as soon as this module loads so the first
// user-triggered request hits the 2s cache instead of a cold relay round-trip.
void (async () => {
  try {
    const { getRemoteApprovalOverview } = await getRemoteAgentsBackend();
    const value = await getRemoteApprovalOverview();
    cachedOverview = { value, expiresAt: Date.now() + OVERVIEW_CACHE_MS };
  } catch { /* non-fatal — first real request will populate the cache */ }
})();

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const now = Date.now();
    // ?bust=1 skips cache — used by post-action refreshes (approve, reject, archive)
    const bust = request.nextUrl.searchParams.get("bust") === "1";
    // ?nologs=1 strips logTail from all jobs — used by list pages that don't display logs
    const nologs = request.nextUrl.searchParams.get("nologs") === "1";
    if (!bust && cachedOverview && cachedOverview.expiresAt > now) {
      const value = nologs ? stripLogs(cachedOverview.value) : cachedOverview.value;
      return jsonWithCorrelation(value, { status: 200 }, correlationId);
    }
    const { getRemoteApprovalOverview } = await getRemoteAgentsBackend();
    if (!inFlight) {
      inFlight = getRemoteApprovalOverview()
        .then((value) => {
          cachedOverview = { value, expiresAt: Date.now() + OVERVIEW_CACHE_MS };
          return value;
        })
        .finally(() => { inFlight = null; });
    }
    const overview = await inFlight;
    const result = nologs ? stripLogs(overview) : overview;
    return jsonWithCorrelation(result, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load remote agent overview" },
      { status: 500 },
      correlationId,
    );
  }
}

function stripLogs(overview: RemoteApprovalOverview): RemoteApprovalOverview {
  return {
    ...overview,
    jobs: overview.jobs.map(({ logTail: _, ...job }) => job),
  };
}
