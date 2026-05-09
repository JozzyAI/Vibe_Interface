import "server-only";

import type { RemoteAgentJob, RemoteApprovalRequest } from "@/lib/types";

export interface RelayDispatchAttempt {
  attempted: boolean;
  delivered: boolean;
  reason?: string;
  error?: string;
}

function relayBaseUrl(): string | null {
  const raw = process.env.PI_RELAY_BASE_URL ?? process.env.PI_RELAY_URL;
  if (!raw) {
    return null;
  }
  let normalized = raw.replace(/\/$/, "");
  if (normalized.startsWith("ws://")) {
    normalized = "http://" + normalized.slice("ws://".length);
  } else if (normalized.startsWith("wss://")) {
    normalized = "https://" + normalized.slice("wss://".length);
  }
  if (normalized.endsWith("/ws")) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

function relayToken(): string | null {
  return process.env.PI_RELAY_PI_TOKEN ?? null;
}

async function postRelay(pathname: string, payload: unknown): Promise<RelayDispatchAttempt> {
  const baseUrl = relayBaseUrl();
  const token = relayToken();
  if (!baseUrl || !token) {
    return {
      attempted: false,
      delivered: false,
      reason: "relay_not_configured",
    };
  }

  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!response.ok) {
      return {
        attempted: true,
        delivered: false,
        error:
          typeof parsed.message === "string"
            ? parsed.message
            : `Relay dispatch failed (${response.status})`,
      };
    }

    return {
      attempted: true,
      delivered: parsed.delivered === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch (error) {
    return {
      attempted: true,
      delivered: false,
      error: error instanceof Error ? error.message : "Relay dispatch failed",
    };
  }
}

export function dispatchRelayApprovalDecision(
  agentId: string,
  request: RemoteApprovalRequest,
): Promise<RelayDispatchAttempt> {
  return postRelay("/v1/pi/approval-decisions", {
    agentId,
    request,
  });
}

export function dispatchRelayJob(
  agentId: string,
  job: RemoteAgentJob,
): Promise<RelayDispatchAttempt> {
  return postRelay("/v1/pi/jobs/dispatch", {
    agentId,
    job,
  });
}
