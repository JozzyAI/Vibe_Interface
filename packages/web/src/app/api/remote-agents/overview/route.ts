import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";
import type { RemoteApprovalOverview } from "@/lib/types";

// 2s coalescing window — long enough to absorb concurrent pollers, short enough to feel live
const OVERVIEW_CACHE_MS = 2_000;
let cachedOverview: { value: RemoteApprovalOverview; expiresAt: number } | null = null;
// Deduplicate concurrent in-flight requests (thundering herd guard)
let inFlight: Promise<RemoteApprovalOverview> | null = null;

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const now = Date.now();
    // ?bust=1 skips cache — used by post-action refreshes (approve, reject, archive)
    // so the UI reflects the write immediately, not a stale 2s window.
    const bust = request.nextUrl.searchParams.get("bust") === "1";
    if (!bust && cachedOverview && cachedOverview.expiresAt > now) {
      return jsonWithCorrelation(cachedOverview.value, { status: 200 }, correlationId);
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
    return jsonWithCorrelation(overview, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load remote agent overview" },
      { status: 500 },
      correlationId,
    );
  }
}
