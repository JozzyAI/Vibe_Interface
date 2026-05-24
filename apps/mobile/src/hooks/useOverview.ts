import { useState, useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";
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
  if (/ECONNREFUSED|ENOTFOUND|network|fetch/i.test(msg)) return "Cannot reach relay — check your URL";
  return "Relay error — pull down to retry";
}

export function useOverview(intervalMs = 5000): OverviewState {
  const [overview, setOverview] = useState<RemoteApprovalOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const mountedRef = useRef(true);

  const fetch = useCallback(async () => {
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
    void fetch();

    const interval = setInterval(() => {
      if (appStateRef.current === "active") void fetch();
    }, intervalMs);

    const subscription = AppState.addEventListener("change", (next) => {
      appStateRef.current = next;
      if (next === "active") void fetch();
    });

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, [fetch, intervalMs]);

  return { overview, loading, error, refresh: () => { void fetch(); } };
}
