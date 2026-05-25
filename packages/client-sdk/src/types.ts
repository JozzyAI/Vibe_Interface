/**
 * Types that form the VI relay API contract.
 * These are serialized/deserialized by the relay server and shared across
 * all client platforms (web, desktop, mobile).
 */

// Approval protocol types
export type VIApprovalPermissionMode = "manual" | "timeout_allow" | "always_allow";
export type VIApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type VIApprovalEventType =
  | "command" | "network_access" | "dependency_install" | "git_push"
  | "delete_operation" | "plan_approval" | "final_approval"
  | "scope_clarification" | "example_request" | "external_action" | "generic";
export type VIApprovalPrimaryAction = "approve" | "reply";
export type VIExternalActionKind =
  | "github_auth" | "codex_update" | "install_tool" | "open_browser_login"
  | "run_host_setup" | "other";

// Agent types
export type RemoteAgentStatus =
  | "running" | "awaiting_approval" | "awaiting_input"
  | "completed" | "failed" | "paused";

export type RemoteAgentConnectionState =
  | "connected" | "stale" | "disconnected" | "disabled";

export interface RemoteRelayState {
  url?: string;
  peerId?: string;
  connected: boolean;
  lastHelloAt?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
}

export interface RemoteEnrollmentSummary {
  enrollmentId: string;
  code: string;
  displayName: string;
  projectLabel: string;
  toolType: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export type RemoteAuthConnectorStatus = "connected" | "missing" | "disconnected" | "unknown";

export interface RemoteAuthConnectorSummary {
  connectorId: string;
  kind: "github" | "npm" | "docker" | "ssh" | "custom";
  label: string;
  status: RemoteAuthConnectorStatus;
  detail?: string;
  account?: string;
  checkedAt: string;
}

export interface RemoteAgentSessionHistoryItem {
  sessionId: string;
  label: string;
  path: string;
  messagePreview?: string;
  lastActivityPreview?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt: string;
  source?: string;
  cliVersion?: string;
  model?: string;
  eventCount?: number;
}

export interface RemoteAgentSummary {
  agentId: string;
  displayName: string;
  projectLabel: string;
  toolType: string;
  hostLabel: string;
  repoRoot?: string;
  branch?: string;
  worktree?: string;
  stateFile?: string;
  logFile?: string;
  status: RemoteAgentStatus;
  lastSeenAt: string;
  permissionMode: VIApprovalPermissionMode;
  timeoutSeconds: number;
  pendingApprovalCount: number;
  connectionState: RemoteAgentConnectionState;
  consecutiveFailures?: number;
  lastError?: string;
  nextRetryAt?: string;
  relay?: RemoteRelayState;
  sessionHistory?: RemoteAgentSessionHistoryItem[];
  authConnectors?: RemoteAuthConnectorSummary[];
}

// Approval types
export interface RemoteApprovalRequest {
  requestId: string;
  agentId: string;
  parentJobId?: string;
  createdJobId?: string;
  title: string;
  message: string;
  riskLevel: VIApprovalRiskLevel;
  command?: string | null;
  actionKind?: VIExternalActionKind;
  suggestedCommand?: string | null;
  helperPrompt?: string | null;
  eventType?: VIApprovalEventType;
  primaryAction?: VIApprovalPrimaryAction;
  status: "open" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  response?: string;
}

// Job types
export type RemoteProviderStateName =
  | "busy" | "waiting_input" | "waiting_approval"
  | "blocked" | "completed" | "unknown";

export interface RemoteProviderState {
  state: RemoteProviderStateName;
  confidence: number;
  reason: string;
  source: "hook" | "pty" | "mixed";
  provider?: string;
  stableForSeconds?: number;
  updatedAt?: string;
}

export interface RemoteAgentJobInput {
  inputId: string;
  text: string;
  submit: boolean;
  key?: "escape";
  createdAt: string;
  sentAt?: string;
  error?: string;
}

export interface RemoteAgentJob {
  jobId: string;
  agentId: string;
  type: "start_agent";
  title: string;
  command: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  parentJobId?: string;
  ralphEnabled?: boolean;
  ralphMode?: "off" | "iteration";
  ralphIteration?: number;
  ralphMaxIterations?: number;
  ralphLastQueuedAt?: string;
  autoResumeUsageLimit?: boolean;
  autoRestartCodex?: boolean;
  model?: string;
  reasoningEffort?: string;
  autoResumeAttempts?: number;
  autoRestartAttempts?: number;
  autoResumeLastAt?: string;
  autoRestartLastAt?: string;
  ralphLastIdleSignature?: string;
  nextResumeAt?: string;
  restartRequiredAt?: string;
  restartedAsJobId?: string;
  continuedAsJobId?: string;
  codexSessionId?: string;
  exitCode?: number;
  pid?: number;
  tmuxSession?: string;
  logFile?: string;
  logTail?: string;
  providerState?: RemoteProviderState;
  artifactsDir?: string;
  handoff?: {
    progress?: string;
    todo?: string;
    notes?: string;
    title?: string;
    updatedAt?: string;
    state?: {
      objective?: string;
      status?: string;
      doing?: string;
      next?: string[];
      done_recent?: string[];
      blockers?: string[];
      decisions?: string[];
      resume_prompt?: string;
      updated_reason?: string;
      updated_at?: string;
    };
  };
  error?: string;
  pendingInputs?: RemoteAgentJobInput[];
  inputHistory?: RemoteAgentJobInput[];
}

// Event types
export type RemoteAgentEventType =
  | "machine.registered" | "machine.connected" | "machine.disconnected"
  | "machine.updated" | "machine.removed" | "machine.daemon_restart_requested"
  | "session.created" | "session.recovered"
  | "session.status_changed" | "session.provider_state_changed"
  | "session.input_queued" | "session.archived" | "session.removed" | "session.restarted"
  | "session.continued" | "session.auto_resume_queued"
  | "session.ralph_iteration_queued" | "approval.requested"
  | "approval.decided" | "policy.updated";

export interface RemoteAgentEvent {
  eventId: string;
  type: RemoteAgentEventType;
  createdAt: string;
  agentId?: string;
  jobId?: string;
  requestId?: string;
  severity?: "info" | "attention" | "warning" | "error";
  metadata?: Record<string, string | number | boolean | null>;
}

// Overview (main dashboard payload)
export interface RemoteApprovalOverview {
  generatedAt: string;
  stats: { agents: number; running: number; pending: number; failed: number };
  agents: RemoteAgentSummary[];
  requests: RemoteApprovalRequest[];
  jobs: RemoteAgentJob[];
  events: RemoteAgentEvent[];
  enrollments: RemoteEnrollmentSummary[];
  recentEnrollments: RemoteEnrollmentSummary[];
}
