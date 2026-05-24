import type {
  RemoteAgentJob,
  RemoteApprovalOverview,
  RemoteApprovalRequest,
  RemoteEnrollmentSummary,
  VIApprovalPermissionMode,
  VIApprovalRiskLevel,
  VIApprovalEventType,
  VIApprovalPrimaryAction,
  PIExternalActionKind,
} from "./types.js";

export interface VIRelayClientConfig {
  baseUrl: string;
  viToken: string;
}

export class VIRelayClient {
  private readonly base: string;
  private readonly token: string;

  constructor(config: VIRelayClientConfig) {
    this.base = config.baseUrl.trim().replace(/\/$/, "").replace(/\/ws$/, "");
    this.token = config.viToken;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: "no-store",
    });
    const json = await res.json() as { error?: string } & T;
    if (!res.ok) throw new Error(json.error ?? `Relay request failed (${res.status})`);
    return json;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = await res.json() as { error?: string } & T;
    if (!res.ok) throw new Error(json.error ?? `Relay request failed (${res.status})`);
    return json;
  }

  private async patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = await res.json() as { error?: string } & T;
    if (!res.ok) throw new Error(json.error ?? `Relay request failed (${res.status})`);
    return json;
  }

  // ── Overview ────────────────────────────────────────────────────────────────

  async getRemoteApprovalOverview(): Promise<RemoteApprovalOverview> {
    return this.get<RemoteApprovalOverview>("/v1/vi/overview");
  }

  // ── Enrollments ─────────────────────────────────────────────────────────────

  async getEnrollments(): Promise<{ enrollments: unknown[]; recentEnrollments: unknown[] }> {
    return this.get("/v1/vi/enrollments");
  }

  async createRemoteEnrollment(input: {
    displayName: string;
    projectLabel: string;
    toolType?: string;
    expiresInMinutes?: number;
  }): Promise<RemoteEnrollmentSummary & { pairCommand?: string; advancedCommand?: string; relayUrl?: string }> {
    const result = await this.post<{
      enrollment: RemoteEnrollmentSummary;
      pairCommand?: string;
      advancedCommand?: string;
      relayUrl?: string;
    }>("/v1/vi/enrollments", input);
    return { ...result.enrollment, pairCommand: result.pairCommand, advancedCommand: result.advancedCommand, relayUrl: result.relayUrl };
  }

  async consumeRemoteEnrollment(input: { code: string }): Promise<{
    enrollment: RemoteEnrollmentSummary;
    config: { displayName: string; projectLabel: string; toolType: string; relayUrl?: string; relayToken?: string };
  }> {
    // No-auth alias so vi-agent pair --server http://dashboard still works in cloud mode
    const res = await fetch(`${this.base}/api/remote-agents/enrollments/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const json = await res.json() as { error?: string; enrollment: RemoteEnrollmentSummary; config: { displayName: string; projectLabel: string; toolType: string; relayUrl?: string; relayToken?: string } };
    if (!res.ok) throw new Error(json.error ?? `Enrollment consume failed (${res.status})`);
    return json;
  }

  async revokeRemoteEnrollment(input: { enrollmentId: string }): Promise<RemoteEnrollmentSummary> {
    const result = await this.post<{ enrollment: RemoteEnrollmentSummary }>(
      `/v1/vi/enrollments/${encodeURIComponent(input.enrollmentId)}/revoke`,
    );
    return result.enrollment;
  }

  async createReconnectEnrollment(agentId: string): Promise<{
    enrollment: RemoteEnrollmentSummary;
    pairCommand: string;
    advancedCommand: string;
    relayUrl: string;
  }> {
    return this.post(`/v1/vi/agents/${encodeURIComponent(agentId)}/reconnect`);
  }

  // ── Jobs ────────────────────────────────────────────────────────────────────

  async createRemoteAgentJob(input: {
    agentId: string;
    title?: string;
    command: string[];
    provider?: string;
    cwd?: string;
    env?: Record<string, string>;
    model?: string | null;
    reasoningEffort?: string | null;
    ralphEnabled?: boolean;
    autoResumeUsageLimit?: boolean;
    autoRestartCodex?: boolean;
  }): Promise<RemoteAgentJob> {
    const result = await this.post<{ job: RemoteAgentJob; relayDispatch: unknown }>("/v1/vi/jobs", input);
    return result.job;
  }

  async archiveRemoteAgentJob(input: { jobId: string; agentId?: string }): Promise<RemoteAgentJob> {
    const result = await this.post<{ job: RemoteAgentJob }>(
      `/v1/vi/jobs/${encodeURIComponent(input.jobId)}/archive`,
      { agentId: input.agentId },
    );
    return result.job;
  }

  async removeRemoteAgentJob(input: { jobId: string; agentId?: string }): Promise<{ removed: boolean; removedJobIds: string[] }> {
    return this.post(
      `/v1/vi/jobs/${encodeURIComponent(input.jobId)}/delete`,
      { agentId: input.agentId },
    );
  }

  async updateRemoteAgentJobSettings(input: {
    jobId: string;
    agentId?: string;
    ralphEnabled?: boolean;
    autoResumeUsageLimit?: boolean;
    autoRestartCodex?: boolean;
    model?: string | null;
    reasoningEffort?: string | null;
  }): Promise<RemoteAgentJob> {
    const { jobId, ...rest } = input;
    const result = await this.patch<{ job: RemoteAgentJob }>(`/v1/vi/jobs/${encodeURIComponent(jobId)}`, rest);
    return result.job;
  }

  async restartRemoteAgentJob(input: { jobId: string; agentId?: string }): Promise<RemoteAgentJob> {
    const result = await this.post<{ job: RemoteAgentJob; relayDispatch: unknown }>(
      `/v1/vi/jobs/${encodeURIComponent(input.jobId)}/restart`,
      { agentId: input.agentId },
    );
    return result.job;
  }

  // ── Approvals ───────────────────────────────────────────────────────────────

  async createRemoteApprovalRequest(input: {
    agentId: string;
    parentJobId?: string;
    title: string;
    message: string;
    riskLevel?: VIApprovalRiskLevel;
    command?: string;
    actionKind?: PIExternalActionKind;
    suggestedCommand?: string;
    helperPrompt?: string;
    eventType?: VIApprovalEventType;
    primaryAction?: VIApprovalPrimaryAction;
  }): Promise<RemoteApprovalRequest> {
    const result = await this.post<{ approvalRequest: RemoteApprovalRequest }>("/v1/vi/approvals", input);
    return result.approvalRequest;
  }

  async respondToRemoteApproval(input: {
    requestId: string;
    action: "approve" | "reject";
    response?: string;
  }): Promise<RemoteApprovalRequest> {
    const result = await this.post<{ approvalRequest: RemoteApprovalRequest; relayDispatch: unknown }>(
      `/v1/vi/approvals/${encodeURIComponent(input.requestId)}/respond`,
      { action: input.action, response: input.response },
    );
    return result.approvalRequest;
  }

  async sendJobInput(
    jobId: string,
    input: { text: string; submit?: boolean; key?: "escape" },
  ): Promise<RemoteAgentJob> {
    const result = await this.post<{ job: RemoteAgentJob; relayDispatch: unknown }>(
      `/v1/vi/jobs/${encodeURIComponent(jobId)}/input`,
      input,
    );
    return result.job;
  }

  async dispatchRelayApprovalDecision(agentId: string, request: unknown): Promise<{ delivered: boolean; targetPeerId: string }> {
    return this.post("/v1/vi/approval-decisions", { agentId, request });
  }

  async dispatchRelayJob(agentId: string, job: unknown): Promise<{ delivered: boolean; targetPeerId: string }> {
    return this.post("/v1/vi/jobs/dispatch", { agentId, job });
  }

  // ── Agents ──────────────────────────────────────────────────────────────────

  async removeRemoteAgent(input: { agentId: string }): Promise<{ removed: boolean }> {
    return this.post(`/v1/vi/agents/${encodeURIComponent(input.agentId)}/remove`);
  }

  async requestRemoteAgentDaemonRestart(agentId: string): Promise<{ command: unknown }> {
    return this.post(`/v1/vi/agents/${encodeURIComponent(agentId)}/restart-daemon`);
  }

  async setRemoteAgentPolicy(input: {
    agentId: string;
    mode?: VIApprovalPermissionMode;
    cycle?: boolean;
    timeoutSeconds?: number;
  }): Promise<unknown> {
    const { cycle: _cycle, ...rest } = input;
    const r = await this.post<{ agent: unknown }>(
      `/v1/vi/agents/${encodeURIComponent(input.agentId)}/policy`,
      rest,
    );
    return r.agent;
  }
}
