/**
 * relay-cloud-client.ts
 *
 * Dashboard HTTP client for PI Cloud relay /v1/pi/* routes.
 * Activated when PI_RELAY_BASE_URL + PI_RELAY_PI_TOKEN are set.
 * Returns the same TypeScript shapes as remote-agents.ts so all API routes
 * and UI components work without changes.
 */
import "server-only";
import type {
  RemoteAgentJob,
  RemoteApprovalOverview,
  RemoteApprovalRequest,
  RemoteEnrollmentSummary,
} from "@/lib/types";

function relayBase(): string {
  return (process.env["PI_RELAY_BASE_URL"] ?? "").trim().replace(/\/$/, "").replace(/\/ws$/, "");
}

function piToken(): string {
  return process.env["PI_RELAY_PI_TOKEN"] ?? "";
}

async function piPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${relayBase()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${piToken()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json = await res.json() as { error?: string } & T;
  if (!res.ok) throw new Error(json.error ?? `Relay request failed (${res.status})`);
  return json;
}

async function piGet<T>(path: string): Promise<T> {
  const res = await fetch(`${relayBase()}${path}`, {
    headers: { Authorization: `Bearer ${piToken()}` },
    cache: "no-store",
  });
  const json = await res.json() as { error?: string } & T;
  if (!res.ok) throw new Error(json.error ?? `Relay request failed (${res.status})`);
  return json;
}

// ── Overview ──────────────────────────────────────────────────────────────────

export async function getRemoteApprovalOverview(): Promise<RemoteApprovalOverview> {
  return piGet<RemoteApprovalOverview>("/v1/pi/overview");
}

// ── Agents (dashboard-side operations only) ───────────────────────────────────
// NOTE: registerRemoteAgent, heartbeatRemoteAgent, pollRemoteAgent, reportRemoteAgentJob
// are daemon routes — pi-agent calls the relay directly in cloud mode.
// The dashboard never mediates those calls. They are NOT exported from relay-cloud-client.

// ── Enrollments ───────────────────────────────────────────────────────────────

export async function getEnrollments() {
  return piGet<{ enrollments: unknown[]; recentEnrollments: unknown[] }>("/v1/pi/enrollments");
}

export async function createRemoteEnrollment(input: {
  displayName: string; projectLabel: string; toolType?: string; expiresInMinutes?: number;
}): Promise<RemoteEnrollmentSummary & { pairCommand?: string; advancedCommand?: string; relayUrl?: string }> {
  const result = await piPost<{
    enrollment: RemoteEnrollmentSummary;
    pairCommand?: string;
    advancedCommand?: string;
    relayUrl?: string;
  }>("/v1/pi/enrollments", input);
  return { ...result.enrollment, pairCommand: result.pairCommand, advancedCommand: result.advancedCommand, relayUrl: result.relayUrl };
}

export async function consumeRemoteEnrollment(input: { code: string }): Promise<{
  enrollment: RemoteEnrollmentSummary;
  config: {
    displayName: string;
    projectLabel: string;
    toolType: string;
    relayUrl?: string;
    relayToken?: string;
  };
}> {
  // Use the relay's no-auth alias so backward-compat pairing still works when
  // dashboard is in cloud mode (pi-agent pair --server http://dashboard).
  const res = await fetch(`${relayBase()}/api/remote-agents/enrollments/consume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const json = await res.json() as { error?: string } & { enrollment: RemoteEnrollmentSummary; config: { displayName: string; projectLabel: string; toolType: string; relayUrl?: string; relayToken?: string } };
  if (!res.ok) throw new Error(json.error ?? `Enrollment consume failed (${res.status})`);
  return json;
}

export async function revokeRemoteEnrollment(input: { enrollmentId: string }): Promise<RemoteEnrollmentSummary> {
  const result = await piPost<{ enrollment: RemoteEnrollmentSummary }>(
    `/v1/pi/enrollments/${encodeURIComponent(input.enrollmentId)}/revoke`,
  );
  return result.enrollment;
}

export async function createReconnectEnrollment(agentId: string): Promise<{
  enrollment: RemoteEnrollmentSummary; pairCommand: string; advancedCommand: string; relayUrl: string;
}> {
  return piPost(`/v1/pi/agents/${encodeURIComponent(agentId)}/reconnect`);
}

// ── Jobs ──────────────────────────────────────────────────────────────────────


export async function createRemoteAgentJob(input: {
  agentId: string; title?: string; command: string[]; provider?: string;
  cwd?: string; env?: Record<string, string>; model?: string | null;
  reasoningEffort?: string | null; ralphEnabled?: boolean;
  autoResumeUsageLimit?: boolean; autoRestartCodex?: boolean;
}): Promise<RemoteAgentJob> {
  const result = await piPost<{ job: RemoteAgentJob; relayDispatch: unknown }>("/v1/pi/jobs", input);
  return result.job;
}

export async function archiveRemoteAgentJob(input: { jobId: string; agentId?: string }): Promise<RemoteAgentJob> {
  const result = await piPost<{ job: RemoteAgentJob }>(
    `/v1/pi/jobs/${encodeURIComponent(input.jobId)}/archive`,
    { agentId: input.agentId },
  );
  return result.job;
}

export async function removeRemoteAgentJob(input: { jobId: string; agentId?: string }) {
  return piPost<{ removed: boolean; removedJobIds: string[] }>(
    `/v1/pi/jobs/${encodeURIComponent(input.jobId)}/delete`,
    { agentId: input.agentId },
  );
}

export async function restartRemoteAgentJob(input: { jobId: string; agentId?: string }): Promise<RemoteAgentJob> {
  const result = await piPost<{ job: RemoteAgentJob; relayDispatch: unknown }>(
    `/v1/pi/jobs/${encodeURIComponent(input.jobId)}/restart`,
    { agentId: input.agentId },
  );
  return result.job;
}

// ── Approvals ─────────────────────────────────────────────────────────────────

export async function createRemoteApprovalRequest(input: {
  agentId: string;
  parentJobId?: string;
  title: string;
  message: string;
  riskLevel?: RemoteApprovalRequest["riskLevel"];
  command?: string;
  actionKind?: RemoteApprovalRequest["actionKind"];
  suggestedCommand?: string;
  helperPrompt?: string;
  eventType?: RemoteApprovalRequest["eventType"];
  primaryAction?: RemoteApprovalRequest["primaryAction"];
}): Promise<RemoteApprovalRequest> {
  const result = await piPost<{ approvalRequest: RemoteApprovalRequest }>("/v1/pi/approvals", input);
  return result.approvalRequest;
}

export async function respondToRemoteApproval(input: {
  requestId: string; action: "approve" | "reject"; response?: string;
}): Promise<RemoteApprovalRequest> {
  const result = await piPost<{ approvalRequest: RemoteApprovalRequest; relayDispatch: unknown }>(
    `/v1/pi/approvals/${encodeURIComponent(input.requestId)}/respond`,
    { action: input.action, response: input.response },
  );
  return result.approvalRequest;
}

export async function dispatchRelayApprovalDecision(agentId: string, request: unknown) {
  return piPost<{ delivered: boolean; targetPeerId: string }>(
    "/v1/pi/approval-decisions",
    { agentId, request },
  );
}

export async function dispatchRelayJob(agentId: string, job: unknown) {
  return piPost<{ delivered: boolean; targetPeerId: string }>(
    "/v1/pi/jobs/dispatch",
    { agentId, job },
  );
}

// ── Agents ────────────────────────────────────────────────────────────────────

export async function removeRemoteAgent(input: { agentId: string }) {
  return piPost<{ removed: boolean }>(
    `/v1/pi/agents/${encodeURIComponent(input.agentId)}/remove`,
  );
}

export async function requestRemoteAgentDaemonRestart(agentId: string) {
  return piPost<{ command: unknown }>(
    `/v1/pi/agents/${encodeURIComponent(agentId)}/restart-daemon`,
  );
}
