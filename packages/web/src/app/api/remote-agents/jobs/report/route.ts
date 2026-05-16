import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
// Daemon route — pi-agent calls relay directly in cloud mode; this stays local-only.
import { reportRemoteAgentJob } from "@/lib/remote-agents";
import type { RemoteProviderState } from "@/lib/types";

const STALE_REPORT_CACHE_MS = 60_000;
const REPORT_DEDUPE_CACHE_MS = 2_000;
const staleReportKeys = new Map<string, number>();
const staleReportAgents = new Map<string, number>();
const recentReportResponses = new Map<string, { signature: string; until: number; body: unknown }>();

function isStaleReportCached(key: string) {
  const staleUntil = staleReportKeys.get(key);
  if (!staleUntil) {
    return false;
  }
  if (staleUntil <= Date.now()) {
    staleReportKeys.delete(key);
    return false;
  }
  return true;
}

function rememberStaleReport(key: string) {
  staleReportKeys.set(key, Date.now() + STALE_REPORT_CACHE_MS);
}

function isStaleReportAgentCached(agentId: string) {
  const staleUntil = staleReportAgents.get(agentId);
  if (!staleUntil) {
    return false;
  }
  if (staleUntil <= Date.now()) {
    staleReportAgents.delete(agentId);
    return false;
  }
  return true;
}

function rememberStaleReportAgent(agentId: string) {
  staleReportAgents.set(agentId, Date.now() + STALE_REPORT_CACHE_MS);
}

function getRecentReport(key: string, signature: string) {
  const cached = recentReportResponses.get(key);
  if (!cached) {
    return null;
  }
  if (cached.until <= Date.now() || cached.signature !== signature) {
    recentReportResponses.delete(key);
    return null;
  }
  return cached.body;
}

function rememberRecentReport(key: string, signature: string, body: unknown) {
  recentReportResponses.set(key, {
    signature,
    until: Date.now() + REPORT_DEDUPE_CACHE_MS,
    body,
  });
}

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  let agentId: string | null = null;
  let staleKey: string | null = null;
  try {
    const body = (await request.json()) as {
      agentId: string;
      jobId: string;
      status: "queued" | "running" | "completed" | "failed";
      pid?: number;
      exitCode?: number;
      tmuxSession?: string;
      logFile?: string;
      logTail?: string;
      providerState?: RemoteProviderState;
      artifactsDir?: string;
      handoffTitle?: string;
      progress?: string;
      todo?: string;
      notes?: string;
      error?: string;
      sentInputIds?: string[];
    };
    agentId = body.agentId;
    staleKey = `${body.agentId}:${body.jobId}`;
    if (isStaleReportAgentCached(agentId)) {
      return jsonWithCorrelation({ ignored: true, shouldStop: true, cached: true }, { status: 410 }, correlationId);
    }
    if (isStaleReportCached(staleKey)) {
      return jsonWithCorrelation({ ignored: true, shouldStop: true, cached: true }, { status: 410 }, correlationId);
    }
    const signature = JSON.stringify(body);
    const recent = getRecentReport(staleKey, signature);
    if (recent) {
      return jsonWithCorrelation({ ...(recent as object), cached: true }, { status: 200 }, correlationId);
    }
    const job = await reportRemoteAgentJob(body);
    const responseBody = { job };
    rememberRecentReport(staleKey, signature, responseBody);
    return jsonWithCorrelation(responseBody, { status: 200 }, correlationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to report remote agent job";
    if (message.startsWith("Remote agent job was removed:") || message.startsWith("Unknown remote agent:")) {
      if (staleKey) {
        rememberStaleReport(staleKey);
      }
      if (agentId) {
        rememberStaleReportAgent(agentId);
      }
      return jsonWithCorrelation({ ignored: true, shouldStop: true, error: message }, { status: 410 }, correlationId);
    }
    return jsonWithCorrelation(
      { error: message },
      { status: 500 },
      correlationId,
    );
  }
}
