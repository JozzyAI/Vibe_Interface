"use client";

/**
 * Polling hierarchy for /api/remote-agents/overview:
 *
 *   Level 1 — list/sidebar pages:     8s normal, 30s when tab hidden
 *   Level 2 — session detail:         2s (provider busy), 5s (waiting_input/approval),
 *                                     15s (completed/failed/archived), 30s when hidden
 *   Level 3 — live terminal open:     5s metadata-only, 30s when hidden
 *
 * Guarantees:
 *   - Only one request in-flight at a time (next fires after previous resolves)
 *   - Pauses when document is hidden, resumes immediately on visibility restore
 *   - Stable: all mutable options read via refs — safe empty-deps effect
 */

import { useEffect, useRef } from "react";
import type { RemoteApprovalOverview } from "@/lib/types";

export type PollingLevel = 1 | 2 | 3;

export interface UseOverviewPollingOptions {
  level: PollingLevel;
  enabled?: boolean;
  slim?: boolean;         // strip logTail server-side (?nologs=1) — use for list pages
  jobStatus?: string;     // job.status: used by level 2 to adapt interval
  providerState?: string; // job.providerState?.state: used by level 2
  onData: (overview: RemoteApprovalOverview) => void;
  onError?: (message: string) => void;
}

function intervalMs(
  level: PollingLevel,
  jobStatus: string | undefined,
  providerState: string | undefined,
  hidden: boolean,
): number {
  if (hidden) return 30_000;
  if (level === 1) return 8_000;
  if (level === 3) return 5_000;
  // Level 2 — session-state adaptive
  if (jobStatus === "completed" || jobStatus === "failed" || jobStatus === "archived") {
    return 15_000;
  }
  if (providerState === "busy") return 2_000;
  return 5_000; // waiting_input, waiting_approval, queued, running (unknown provider state)
}

export function useOverviewPolling({
  level,
  enabled = true,
  slim = false,
  jobStatus,
  providerState,
  onData,
  onError,
}: UseOverviewPollingOptions): void {
  // All mutable options live in refs so the loop closure never goes stale
  const levelRef = useRef(level);
  const slimRef = useRef(slim);
  const jobStatusRef = useRef(jobStatus);
  const providerStateRef = useRef(providerState);
  const enabledRef = useRef(enabled);
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);

  levelRef.current = level;
  slimRef.current = slim;
  jobStatusRef.current = jobStatus;
  providerStateRef.current = providerState;
  enabledRef.current = enabled;
  onDataRef.current = onData;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (cancelled || !enabledRef.current) return;

      if (document.visibilityState !== "visible") {
        timerId = setTimeout(poll, 30_000);
        return;
      }

      try {
        const url = slimRef.current
          ? "/api/remote-agents/overview?nologs=1"
          : "/api/remote-agents/overview";
        const res = await fetch(url, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as RemoteApprovalOverview;
        if (!cancelled) onDataRef.current(data);
      } catch (err) {
        if (!cancelled) {
          onErrorRef.current?.(err instanceof Error ? err.message : "Failed to refresh");
        }
      }

      if (cancelled) return;
      const delay = intervalMs(
        levelRef.current,
        jobStatusRef.current,
        providerStateRef.current,
        document.visibilityState !== "visible",
      );
      timerId = setTimeout(poll, delay);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timerId);
        void poll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled]); // restarts if enabled flips true→false→true
}
