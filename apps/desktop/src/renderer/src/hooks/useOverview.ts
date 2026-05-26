import { useState, useEffect, useRef, useCallback } from "react";
import type { RemoteApprovalOverview } from "@vi/client-sdk";
import { getClient } from "../client";

export interface OverviewState {
  overview: RemoteApprovalOverview | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|403|forbidden|unauthorized/i.test(msg)) return "Auth failed — check your token in Setup";
  if (/ECONNREFUSED|ENOTFOUND|network|fetch|Failed to fetch/i.test(msg)) return "Cannot reach relay — check your URL";
  if (/Not configured/i.test(msg)) return "Not configured — open Setup to connect";
  return "Relay error — click Retry";
}

export function useOverview(intervalMs = 5000): OverviewState {
  const [overview, setOverview] = useState<RemoteApprovalOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const visibleRef = useRef(true);

  const doFetch = useCallback(async () => {
    try {
      const client = await getClient();
      const data = await client.getRemoteApprovalOverview();
      if (!mountedRef.current) return;
      setOverview(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(classifyError(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void doFetch();

    const interval = setInterval(() => {
      if (visibleRef.current) void doFetch();
    }, intervalMs);

    const onVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) void doFetch();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [doFetch, intervalMs]);

  return { overview, loading, error, refresh: () => { void doFetch(); } };
}
