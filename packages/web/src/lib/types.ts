/**
 * Dashboard-specific types for the PI web UI.
 * All types are PI-owned — no external agent framework dependency.
 */

// Re-export PI core types used throughout the dashboard
export type {
  PISession,
  PISessionState,
  PIRequestKind,
  PIRequestStatus,
  PIActivityState,
  PISessionStatus,
  CIStatus,
} from "@pi/core";

import type { PISessionState, PISessionStatus, PIActivityState, CIStatus } from "@pi/core";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export type ReviewDecision = "approved" | "changes_requested" | "commented" | "pending" | "none";
export type MergeReadiness = {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
};
export type PRState = "open" | "merged" | "closed";
export type AttentionLevel = "merge" | "respond" | "review" | "pending" | "working" | "done";

export const SESSION_STATUS = {
  ERRORED: "errored" as PISessionStatus,
  NEEDS_INPUT: "needs_input" as PISessionStatus,
  STUCK: "stuck" as PISessionStatus,
  MERGED: "merged" as PISessionStatus,
  DONE: "done" as PISessionStatus,
} as const;

export const ACTIVITY_STATE = {
  WAITING_INPUT: "waiting_input" as PIActivityState,
  BLOCKED: "blocked" as PIActivityState,
  EXITED: "exited" as PIActivityState,
  ACTIVE: "active" as PIActivityState,
  IDLE: "idle" as PIActivityState,
} as const;

export const CI_STATUS = {
  PASSING: "passed" as CIStatus,
  FAILING: "failed" as CIStatus,
  PENDING: "pending" as CIStatus,
} as const;

export const TERMINAL_STATUSES: ReadonlySet<PISessionStatus> = new Set([
  "killed", "terminated", "done", "cleanup", "errored", "merged",
]);
export const TERMINAL_ACTIVITIES: ReadonlySet<PIActivityState> = new Set(["exited"]);
export const NON_RESTORABLE_STATUSES: ReadonlySet<PISessionStatus> = new Set(["merged"]);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface DashboardSession {
  id: string;
  projectId: string;
  status: PISessionStatus;
  piState?: PISessionState;
  activity: PIActivityState | null;
  branch: string | null;
  issueId: string | null;
  issueUrl: string | null;
  issueLabel: string | null;
  issueTitle: string | null;
  userPrompt: string | null;
  summary: string | null;
  summaryIsFallback: boolean;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// PI inbox / control plane types
// ---------------------------------------------------------------------------

export interface PIInboxItem {
  requestId: string;
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  kind: PIRequestKind;
  status: PIRequestStatus;
  title: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  response?: string;
}

export interface PIRecoveryItem {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  piState: PISessionState;
  aoStatus: PISessionStatus;
  lastActivityAt: string;
  summary: string | null;
  restoreAvailable: boolean;
}

export interface PIBacklogItem {
  projectId: string;
  issueId: string;
  title: string;
  url: string;
  labels: string[];
}

export interface PIGitHubConnectorSummary {
  id: string;
  label: string;
  host: string;
  accountLogin: string;
  owner: string;
  repo: string;
  authType: "personal_access_token" | "oauth";
  tokenPreview: string;
  createdAt: string;
  updatedAt: string;
  isSelected: boolean;
}

export interface PIGitHubConnectorState {
  available: boolean;
  projectId?: string;
  selectedConnectorId: string | null;
  connectors: PIGitHubConnectorSummary[];
}

export interface PIIdeaDraft {
  order: number;
  title: string;
  description: string;
  labels: string[];
  suggestedAgent: string;
  stage: string;
}

export interface PIIdeaPlanPayload {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: string;
  source: string;
  labels: string[];
  issues: PIIdeaDraft[];
}

export type PIIdeaStatus = "idea_bank" | "project_queue" | "working" | "done";

export interface PIIdeaCard {
  id: string;
  title: string;
  markdown: string;
  excerpt: string;
  status: PIIdeaStatus;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  sessionStatus?: string | null;
}

export interface PIIdeaBoardColumnData {
  id: PIIdeaStatus;
  title: string;
  description: string;
  ideas: PIIdeaCard[];
}

export interface PIIdeaBoardData {
  projectId: string;
  generatedAt: string;
  columns: PIIdeaBoardColumnData[];
}

export interface PIControlPlaneData {
  generatedAt: string;
  projectId?: string;
  counts: { inbox: number; recovery: number; backlog: number };
  github: PIGitHubConnectorState;
  inbox: PIInboxItem[];
  recovery: PIRecoveryItem[];
  backlog: PIBacklogItem[];
}

// ---------------------------------------------------------------------------
// Approval hub types
// ---------------------------------------------------------------------------

export type PIApprovalPermissionMode = "manual" | "timeout_allow" | "always_allow";
export type PIApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type PIApprovalEventType =
  | "command" | "network_access" | "dependency_install" | "git_push"
  | "delete_operation" | "plan_approval" | "final_approval"
  | "scope_clarification" | "example_request" | "external_action" | "generic";
export type PIApprovalPrimaryAction = "approve" | "reply";
export type PIExternalActionKind =
  | "github_auth" | "codex_update" | "install_tool" | "open_browser_login"
  | "run_host_setup" | "other";

export interface PIApprovalPolicySummary {
  scopeType: "project" | "session";
  scopeId: string;
  label: string;
  mode: PIApprovalPermissionMode;
  timeoutSeconds: number;
  updatedAt: string;
}

export interface PIApprovalAuditEntry {
  id: string;
  createdAt: string;
  actorLabel: string;
  eventType: "policy_changed" | "approval_response" | "request_created";
  title: string;
  details: string;
  sessionId?: string;
  requestId?: string;
}

export interface PIApprovalFleetItem {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  status: PISessionStatus;
  piState?: PISessionState;
  toolType: string;
  hostLabel: string;
  repoRoot?: string;
  branch?: string;
  worktree?: string;
  summary: string | null;
  permissionMode: PIApprovalPermissionMode;
  timeoutSeconds: number;
  pendingApprovalCount: number;
  riskLevel: PIApprovalRiskLevel;
  lastActivityAt: string;
}

export interface PIApprovalInboxEntry extends PIInboxItem {
  actionLabel: string;
  riskLevel: PIApprovalRiskLevel;
  permissionMode: PIApprovalPermissionMode;
  timeoutSeconds: number;
  sourceType: "pi_request" | "native_command";
  nativeCommand?: string | null;
  context: {
    eventType: PIApprovalEventType;
    primaryAction: PIApprovalPrimaryAction;
    command?: string | null;
    toolType?: string | null;
    repoRoot?: string | null;
    worktree?: string | null;
    branch?: string | null;
    sourceLabel?: string | null;
  };
}

export interface PIApprovalHubData {
  generatedAt: string;
  projectId: string;
  stats: {
    agents: number; running: number; awaitingApproval: number;
    awaitingInput: number; failed: number; completed: number; inbox: number;
  };
  projectPolicy: PIApprovalPolicySummary;
  fleet: PIApprovalFleetItem[];
  inbox: PIApprovalInboxEntry[];
  recovery: PIRecoveryItem[];
  policies: PIApprovalPolicySummary[];
  history: PIApprovalAuditEntry[];
}

// ---------------------------------------------------------------------------
// Remote agents types (unchanged — already PI-owned)
// ---------------------------------------------------------------------------

export type RemoteAgentStatus = "running" | "awaiting_approval" | "awaiting_input" | "completed" | "failed" | "paused";
export type RemoteAgentConnectionState = "connected" | "stale" | "disconnected" | "disabled";

export interface RemoteRelayState {
  url?: string; peerId?: string; connected: boolean;
  lastHelloAt?: string; lastHeartbeatAt?: string; lastError?: string;
}

export interface RemoteEnrollmentSummary {
  enrollmentId: string; code: string; displayName: string; projectLabel: string;
  toolType: string; createdAt: string; expiresAt: string;
  consumedAt?: string; revokedAt?: string;
}

export interface RemoteAgentSummary {
  agentId: string; displayName: string; projectLabel: string; toolType: string;
  hostLabel: string; repoRoot?: string; branch?: string; worktree?: string;
  stateFile?: string; logFile?: string; status: RemoteAgentStatus;
  lastSeenAt: string; permissionMode: PIApprovalPermissionMode;
  timeoutSeconds: number; pendingApprovalCount: number;
  connectionState: RemoteAgentConnectionState;
  consecutiveFailures?: number; lastError?: string; nextRetryAt?: string;
  relay?: RemoteRelayState; sessionHistory?: RemoteAgentSessionHistoryItem[];
  authConnectors?: RemoteAuthConnectorSummary[];
}

export type RemoteAuthConnectorStatus = "connected" | "missing" | "disconnected" | "unknown";

export interface RemoteAuthConnectorSummary {
  connectorId: string; kind: "github" | "npm" | "docker" | "ssh" | "custom";
  label: string; status: RemoteAuthConnectorStatus; detail?: string;
  account?: string; checkedAt: string;
}

export interface RemoteAgentSessionHistoryItem {
  sessionId: string; label: string; path: string; messagePreview?: string;
  lastActivityPreview?: string; cwd?: string; createdAt?: string;
  updatedAt: string; source?: string; cliVersion?: string; model?: string; eventCount?: number;
}

export interface RemoteApprovalRequest {
  requestId: string; agentId: string; parentJobId?: string; createdJobId?: string;
  title: string; message: string; riskLevel: PIApprovalRiskLevel;
  command?: string | null; actionKind?: PIExternalActionKind;
  suggestedCommand?: string | null; helperPrompt?: string | null;
  eventType?: PIApprovalEventType; primaryAction?: PIApprovalPrimaryAction;
  status: "open" | "approved" | "rejected"; createdAt: string; updatedAt: string; response?: string;
}

export type RemoteProviderStateName = "busy" | "waiting_input" | "waiting_approval" | "blocked" | "completed" | "unknown";

export interface RemoteProviderState {
  state: RemoteProviderStateName; confidence: number; reason: string;
  source: "hook" | "pty" | "mixed"; provider?: string;
  stableForSeconds?: number; updatedAt?: string;
}

export interface RemoteAgentJob {
  jobId: string; agentId: string; type: "start_agent"; title: string;
  command: string[]; cwd?: string | null; env?: Record<string, string>;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string; updatedAt: string; startedAt?: string;
  completedAt?: string; archivedAt?: string; parentJobId?: string;
  ralphEnabled?: boolean; ralphMode?: "off" | "iteration";
  ralphIteration?: number; ralphMaxIterations?: number; ralphLastQueuedAt?: string;
  autoResumeUsageLimit?: boolean; autoRestartCodex?: boolean;
  model?: string; reasoningEffort?: string;
  autoResumeAttempts?: number; autoRestartAttempts?: number;
  autoResumeLastAt?: string; autoRestartLastAt?: string;
  ralphLastIdleSignature?: string; nextResumeAt?: string;
  restartRequiredAt?: string; restartedAsJobId?: string; continuedAsJobId?: string;
  codexSessionId?: string; exitCode?: number; pid?: number;
  tmuxSession?: string; logFile?: string; logTail?: string;
  providerState?: RemoteProviderState; artifactsDir?: string;
  handoff?: {
    progress?: string; todo?: string; notes?: string; title?: string; updatedAt?: string;
    state?: {
      objective?: string; status?: string; doing?: string; next?: string[];
      done_recent?: string[]; blockers?: string[]; decisions?: string[];
      resume_prompt?: string; updated_reason?: string; updated_at?: string;
    };
  };
  error?: string; pendingInputs?: RemoteAgentJobInput[]; inputHistory?: RemoteAgentJobInput[];
}

export interface RemoteAgentJobInput {
  inputId: string; text: string; submit: boolean; key?: "escape";
  createdAt: string; sentAt?: string; error?: string;
}

export type RemoteAgentEventType =
  | "machine.registered" | "machine.connected" | "machine.disconnected"
  | "machine.updated" | "session.created" | "session.recovered"
  | "session.status_changed" | "session.provider_state_changed"
  | "session.input_queued" | "session.archived" | "session.restarted"
  | "session.continued" | "session.auto_resume_queued"
  | "session.ralph_iteration_queued" | "approval.requested"
  | "approval.decided" | "policy.updated";

export interface RemoteAgentEvent {
  eventId: string; type: RemoteAgentEventType; createdAt: string;
  agentId?: string; jobId?: string; requestId?: string;
  severity?: "info" | "attention" | "warning" | "error";
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RemoteApprovalOverview {
  generatedAt: string;
  stats: { agents: number; running: number; pending: number; failed: number };
  agents: RemoteAgentSummary[]; requests: RemoteApprovalRequest[];
  jobs: RemoteAgentJob[]; events: RemoteAgentEvent[];
  enrollments: RemoteEnrollmentSummary[]; recentEnrollments: RemoteEnrollmentSummary[];
}

// ---------------------------------------------------------------------------
// Dashboard PR types
// ---------------------------------------------------------------------------

export interface DashboardCICheck {
  name: string;
  status: CIStatus;
  url?: string;
}

export type DashboardMergeability = MergeReadiness;

export interface DashboardUnresolvedComment {
  url: string; path: string; author: string; body: string;
}

export interface DashboardPR {
  number: number; url: string; title: string; owner: string; repo: string;
  branch: string; baseBranch: string; isDraft: boolean;
  state: PRState; additions: number; deletions: number; changedFiles?: number;
  ciStatus: CIStatus; ciChecks: DashboardCICheck[]; reviewDecision: ReviewDecision;
  mergeability: DashboardMergeability; unresolvedThreads: number;
  unresolvedComments: DashboardUnresolvedComment[]; enriched?: boolean;
}

export interface DashboardStats {
  totalSessions: number; workingSessions: number; openPRs: number; needsReview: number;
}

export interface DashboardOrchestratorLink {
  id: string; projectId: string; projectName: string;
}

export interface SSESnapshotEvent {
  type: "snapshot"; correlationId?: string; emittedAt?: string;
  sessions: Array<{
    id: string; status: PISessionStatus; activity: PIActivityState | null;
    attentionLevel: AttentionLevel; lastActivityAt: string;
  }>;
}

export interface SSEActivityEvent {
  type: "session.activity"; sessionId: string;
  activity: PIActivityState | null; status: PISessionStatus;
  attentionLevel: AttentionLevel; timestamp: string;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function isPRRateLimited(pr: DashboardPR): boolean {
  return pr.mergeability.blockers.includes("API rate limited or unavailable");
}

export function isPRUnenriched(pr: DashboardPR): boolean {
  return pr.enriched === false;
}

export function isPRMergeReady(pr: DashboardPR): boolean {
  return pr.state === "open" && pr.mergeability.mergeable && pr.mergeability.ciPassing &&
    pr.mergeability.approved && pr.mergeability.noConflicts;
}

export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  if (session.piState === "merged") return "done";
  if (session.piState === "review_ready") return "merge";
  if (session.piState === "awaiting_user_input" || session.piState === "awaiting_approval" ||
      session.piState === "blocked" || session.piState === "failed") return "respond";

  if (session.status === "merged" || session.status === "killed" || session.status === "cleanup" ||
      session.status === "done" || session.status === "terminated") return "done";
  if (session.pr?.state === "merged" || session.pr?.state === "closed") return "done";

  if (session.status === "mergeable" || session.status === "approved") return "merge";
  if (session.pr && !isPRUnenriched(session.pr) && session.pr.mergeability.mergeable) return "merge";

  if (session.status === SESSION_STATUS.ERRORED || session.status === SESSION_STATUS.NEEDS_INPUT ||
      session.status === SESSION_STATUS.STUCK) return "respond";
  if (session.activity === ACTIVITY_STATE.WAITING_INPUT || session.activity === ACTIVITY_STATE.BLOCKED ||
      session.activity === ACTIVITY_STATE.EXITED) return "respond";

  if (session.status === "ci_failed" || session.status === "changes_requested") return "review";
  if (session.pr && !isPRRateLimited(session.pr) && !isPRUnenriched(session.pr)) {
    if (session.pr.ciStatus === CI_STATUS.FAILING) return "review";
    if (session.pr.reviewDecision === "changes_requested") return "review";
    if (!session.pr.mergeability.noConflicts) return "review";
  }

  if (session.status === "review_pending") return "pending";
  if (session.pr && !isPRRateLimited(session.pr) && !isPRUnenriched(session.pr)) {
    if (!session.pr.isDraft && session.pr.unresolvedThreads > 0) return "pending";
    if (!session.pr.isDraft && (session.pr.reviewDecision === "pending" || session.pr.reviewDecision === "none")) return "pending";
  }

  return "working";
}

// Import these after defining them to avoid forward-reference issues
import type { PIRequestKind, PIRequestStatus } from "@pi/core";
