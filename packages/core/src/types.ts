import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Session status & activity
// ---------------------------------------------------------------------------

export type VISessionStatus =
  | "spawning"
  | "working"
  | "pr_open"
  | "ci_failed"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "mergeable"
  | "merged"
  | "cleanup"
  | "done"
  | "needs_input"
  | "stuck"
  | "errored"
  | "terminated"
  | "killed";

export type VIActivityState =
  | "active"
  | "ready"
  | "idle"
  | "waiting_input"
  | "blocked"
  | "exited";

export type CIStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type ReviewDecision = "approved" | "changes_requested" | "commented";

export const VI_TERMINAL_STATUSES: ReadonlySet<VISessionStatus> = new Set([
  "killed",
  "terminated",
  "done",
  "cleanup",
  "errored",
  "merged",
]);

export const VI_TERMINAL_ACTIVITIES: ReadonlySet<VIActivityState> = new Set(["exited"]);
export const VI_NON_RESTORABLE_STATUSES: ReadonlySet<VISessionStatus> = new Set(["merged"]);

export function isTerminalVISession(session: {
  status: VISessionStatus;
  activity: VIActivityState | null;
}): boolean {
  return (
    VI_TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && VI_TERMINAL_ACTIVITIES.has(session.activity))
  );
}

export function isVISessionRestorable(session: {
  status: VISessionStatus;
  activity: VIActivityState | null;
}): boolean {
  return isTerminalVISession(session) && !VI_NON_RESTORABLE_STATUSES.has(session.status);
}

// ---------------------------------------------------------------------------
// Core session type
// ---------------------------------------------------------------------------

export interface VISession {
  id: string;
  title: string;
  projectId: string;
  issueId?: string;
  status: VISessionStatus;
  activity: VIActivityState | null;
  branch?: string | null;
  pr?: { url: string; number: number } | null;
  tool: string;
  budget: { estimatedTokens: number; estimatedUsd: number };
  lastUpdate: string;
  createdAt: string;
  updatedAt: string;
  agentInfo?: { summary?: string } | null;
  metadata: Record<string, string>;
  events?: VISessionEvent[];
  needsRestore?: boolean;
}

export interface VISessionEvent {
  id: string;
  sessionId: string;
  type: string;
  summary: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Project & tracker config
// ---------------------------------------------------------------------------

export interface VIProjectConfig {
  projectId: string;
  projectPath: string;
  name?: string;
  repo?: string;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  labels: string[];
  assignee?: string;
}

export interface VITracker {
  name: string;
  createIssue?: (
    input: CreateIssueInput,
    project: VIProjectConfig,
  ) => Promise<{ id: string; title: string; url: string; labels: string[] }>;
}

// ---------------------------------------------------------------------------
// Mock sessions for first-run / standalone demo
// ---------------------------------------------------------------------------

export function createMockVISessions(): VISession[] {
  const now = new Date();
  const minsAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();

  return [
    {
      id: `session_${randomUUID()}`,
      title: "Add user authentication flow",
      projectId: "demo",
      issueId: "issue_001",
      status: "working",
      activity: "active",
      branch: "feat/auth-flow",
      pr: null,
      tool: "claude-code",
      budget: { estimatedTokens: 12400, estimatedUsd: 0.62 },
      lastUpdate: "Implementing JWT refresh token logic",
      createdAt: minsAgo(47),
      updatedAt: minsAgo(3),
      agentInfo: { summary: "Working on JWT middleware and refresh token storage" },
      metadata: {},
      events: [
        { id: randomUUID(), sessionId: "demo-1", type: "session.started", summary: "Started on branch feat/auth-flow", createdAt: minsAgo(47) },
        { id: randomUUID(), sessionId: "demo-1", type: "session.state_changed", summary: "Scaffolded auth middleware", createdAt: minsAgo(32) },
        { id: randomUUID(), sessionId: "demo-1", type: "session.state_changed", summary: "Implementing JWT refresh token logic", createdAt: minsAgo(3) },
      ],
    },
    {
      id: `session_${randomUUID()}`,
      title: "Fix rate limiter edge case",
      projectId: "demo",
      status: "needs_input",
      activity: "waiting_input",
      branch: "fix/rate-limiter",
      pr: null,
      tool: "codex",
      budget: { estimatedTokens: 5200, estimatedUsd: 0.26 },
      lastUpdate: "Needs clarification on burst window behaviour",
      createdAt: minsAgo(91),
      updatedAt: minsAgo(18),
      agentInfo: { summary: "Awaiting clarification on burst window size" },
      metadata: {},
    },
    {
      id: `session_${randomUUID()}`,
      title: "Dashboard performance pass",
      projectId: "demo",
      status: "pr_open",
      activity: "idle",
      branch: "perf/dashboard",
      pr: { url: "https://github.com/example/repo/pull/42", number: 42 },
      tool: "claude-code",
      budget: { estimatedTokens: 18700, estimatedUsd: 0.94 },
      lastUpdate: "PR open — CI passing",
      createdAt: minsAgo(310),
      updatedAt: minsAgo(55),
      agentInfo: { summary: "Reduced initial render time by 40%" },
      metadata: {},
    },
    {
      id: `session_${randomUUID()}`,
      title: "Database migration script",
      projectId: "demo",
      status: "errored",
      activity: "exited",
      branch: "chore/migration-v2",
      pr: null,
      tool: "codex",
      budget: { estimatedTokens: 3100, estimatedUsd: 0.16 },
      lastUpdate: "Migration failed on column constraint",
      createdAt: minsAgo(200),
      updatedAt: minsAgo(130),
      needsRestore: true,
      agentInfo: null,
      metadata: {},
    },
  ];
}
