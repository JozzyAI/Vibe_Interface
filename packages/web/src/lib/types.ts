/**
 * Dashboard-specific types for the VI web UI.
 * All types are VI-owned — no external agent framework dependency.
 */

// Re-export VI core types used throughout the dashboard
export type {
  VISession,
  VISessionState,
  VIRequestKind,
  VIRequestStatus,
  VIActivityState,
  VISessionStatus,
  CIStatus,
} from "@vi/core";

import type { VISessionState, VISessionStatus, VIActivityState, CIStatus } from "@vi/core";
import type {
  VIApprovalPermissionMode,
  VIApprovalRiskLevel,
  VIApprovalEventType,
  VIApprovalPrimaryAction,
} from "@vi/client-sdk";

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
  ERRORED: "errored" as VISessionStatus,
  NEEDS_INPUT: "needs_input" as VISessionStatus,
  STUCK: "stuck" as VISessionStatus,
  MERGED: "merged" as VISessionStatus,
  DONE: "done" as VISessionStatus,
} as const;

export const ACTIVITY_STATE = {
  WAITING_INPUT: "waiting_input" as VIActivityState,
  BLOCKED: "blocked" as VIActivityState,
  EXITED: "exited" as VIActivityState,
  ACTIVE: "active" as VIActivityState,
  IDLE: "idle" as VIActivityState,
} as const;

export const CI_STATUS = {
  PASSING: "passed" as CIStatus,
  FAILING: "failed" as CIStatus,
  PENDING: "pending" as CIStatus,
} as const;

export const TERMINAL_STATUSES: ReadonlySet<VISessionStatus> = new Set([
  "killed", "terminated", "done", "cleanup", "errored", "merged",
]);
export const TERMINAL_ACTIVITIES: ReadonlySet<VIActivityState> = new Set(["exited"]);
export const NON_RESTORABLE_STATUSES: ReadonlySet<VISessionStatus> = new Set(["merged"]);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface DashboardSession {
  id: string;
  projectId: string;
  status: VISessionStatus;
  piState?: VISessionState;
  activity: VIActivityState | null;
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
// VI inbox / control plane types
// ---------------------------------------------------------------------------

export interface VIInboxItem {
  requestId: string;
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  kind: VIRequestKind;
  status: VIRequestStatus;
  title: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  response?: string;
}

export interface VIRecoveryItem {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  piState: VISessionState;
  aoStatus: VISessionStatus;
  lastActivityAt: string;
  summary: string | null;
  restoreAvailable: boolean;
}

export interface VIBacklogItem {
  projectId: string;
  issueId: string;
  title: string;
  url: string;
  labels: string[];
}

export interface VIGitHubConnectorSummary {
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

export interface VIGitHubConnectorState {
  available: boolean;
  projectId?: string;
  selectedConnectorId: string | null;
  connectors: VIGitHubConnectorSummary[];
}

export interface VIIdeaDraft {
  order: number;
  title: string;
  description: string;
  labels: string[];
  suggestedAgent: string;
  stage: string;
}

export interface VIIdeaPlanPayload {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: string;
  source: string;
  labels: string[];
  issues: VIIdeaDraft[];
}

export type VIIdeaStatus = "idea_bank" | "project_queue" | "working" | "done";

export interface VIIdeaCard {
  id: string;
  title: string;
  markdown: string;
  excerpt: string;
  status: VIIdeaStatus;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  sessionStatus?: string | null;
}

export interface VIIdeaBoardColumnData {
  id: VIIdeaStatus;
  title: string;
  description: string;
  ideas: VIIdeaCard[];
}

export interface VIIdeaBoardData {
  projectId: string;
  generatedAt: string;
  columns: VIIdeaBoardColumnData[];
}

export interface VIControlPlaneData {
  generatedAt: string;
  projectId?: string;
  counts: { inbox: number; recovery: number; backlog: number };
  github: VIGitHubConnectorState;
  inbox: VIInboxItem[];
  recovery: VIRecoveryItem[];
  backlog: VIBacklogItem[];
}

// ---------------------------------------------------------------------------
// Approval hub types
// ---------------------------------------------------------------------------

export interface VIApprovalPolicySummary {
  scopeType: "project" | "session";
  scopeId: string;
  label: string;
  mode: VIApprovalPermissionMode;
  timeoutSeconds: number;
  updatedAt: string;
}

export interface VIApprovalAuditEntry {
  id: string;
  createdAt: string;
  actorLabel: string;
  eventType: "policy_changed" | "approval_response" | "request_created";
  title: string;
  details: string;
  sessionId?: string;
  requestId?: string;
}

export interface VIApprovalFleetItem {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  status: VISessionStatus;
  piState?: VISessionState;
  toolType: string;
  hostLabel: string;
  repoRoot?: string;
  branch?: string;
  worktree?: string;
  summary: string | null;
  permissionMode: VIApprovalPermissionMode;
  timeoutSeconds: number;
  pendingApprovalCount: number;
  riskLevel: VIApprovalRiskLevel;
  lastActivityAt: string;
}

export interface VIApprovalInboxEntry extends VIInboxItem {
  actionLabel: string;
  riskLevel: VIApprovalRiskLevel;
  permissionMode: VIApprovalPermissionMode;
  timeoutSeconds: number;
  sourceType: "pi_request" | "native_command";
  nativeCommand?: string | null;
  context: {
    eventType: VIApprovalEventType;
    primaryAction: VIApprovalPrimaryAction;
    command?: string | null;
    toolType?: string | null;
    repoRoot?: string | null;
    worktree?: string | null;
    branch?: string | null;
    sourceLabel?: string | null;
  };
}

export interface VIApprovalHubData {
  generatedAt: string;
  projectId: string;
  stats: {
    agents: number; running: number; awaitingApproval: number;
    awaitingInput: number; failed: number; completed: number; inbox: number;
  };
  projectPolicy: VIApprovalPolicySummary;
  fleet: VIApprovalFleetItem[];
  inbox: VIApprovalInboxEntry[];
  recovery: VIRecoveryItem[];
  policies: VIApprovalPolicySummary[];
  history: VIApprovalAuditEntry[];
}

// ---------------------------------------------------------------------------
// Remote agents types — re-exported from @vi/client-sdk (canonical source)
// ---------------------------------------------------------------------------

export type {
  VIApprovalPermissionMode,
  VIApprovalRiskLevel,
  VIApprovalEventType,
  VIApprovalPrimaryAction,
  PIExternalActionKind,
  RemoteAgentStatus,
  RemoteAgentConnectionState,
  RemoteRelayState,
  RemoteEnrollmentSummary,
  RemoteAuthConnectorStatus,
  RemoteAuthConnectorSummary,
  RemoteAgentSessionHistoryItem,
  RemoteAgentSummary,
  RemoteApprovalRequest,
  RemoteProviderStateName,
  RemoteProviderState,
  RemoteAgentJobInput,
  RemoteAgentJob,
  RemoteAgentEventType,
  RemoteAgentEvent,
  RemoteApprovalOverview,
} from "@vi/client-sdk";

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
    id: string; status: VISessionStatus; activity: VIActivityState | null;
    attentionLevel: AttentionLevel; lastActivityAt: string;
  }>;
}

export interface SSEActivityEvent {
  type: "session.activity"; sessionId: string;
  activity: VIActivityState | null; status: VISessionStatus;
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
import type { VIRequestKind, VIRequestStatus } from "@vi/core";
