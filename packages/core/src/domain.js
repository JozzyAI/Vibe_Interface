import { randomUUID } from "node:crypto";

export const SESSION_STATES = Object.freeze([
  "queued",
  "running",
  "awaiting_user_input",
  "awaiting_approval",
  "blocked",
  "review_ready",
  "merged",
  "failed"
]);

export const REQUEST_KINDS = Object.freeze([
  "example_request",
  "scope_clarification",
  "plan_approval",
  "final_approval"
]);

export function nowIso() {
  return new Date().toISOString();
}

export function createIdea(input = {}) {
  const acceptanceCriteria = Array.isArray(input.acceptanceCriteria)
    ? input.acceptanceCriteria.filter(Boolean)
    : [];

  return {
    id: input.id ?? `idea_${randomUUID()}`,
    title: input.title ?? "Untitled idea",
    description: input.description ?? "",
    repo: input.repo ?? "unknown/repo",
    priority: input.priority ?? "medium",
    labels: Array.isArray(input.labels) ? input.labels : [],
    acceptanceCriteria,
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    createdAt: input.createdAt ?? nowIso(),
    source: input.source ?? "dashboard",
    status: input.status ?? "draft"
  };
}

export function createIssueTask(input = {}) {
  return {
    id: input.id ?? `issue_${randomUUID()}`,
    title: input.title ?? "Untitled task",
    body: input.body ?? "",
    repo: input.repo ?? "unknown/repo",
    labels: Array.isArray(input.labels) ? input.labels : [],
    priority: input.priority ?? "medium",
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : [],
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria)
      ? input.acceptanceCriteria
      : [],
    estimate: input.estimate ?? { points: 1, tokens: 1000 },
    status: input.status ?? "planned"
  };
}

export function createSession(input = {}) {
  const state = input.state ?? "queued";
  if (!SESSION_STATES.includes(state)) {
    throw new Error(`Unknown session state: ${state}`);
  }

  return {
    id: input.id ?? `session_${randomUUID()}`,
    repo: input.repo ?? "unknown/repo",
    ideaId: input.ideaId ?? null,
    issueId: input.issueId ?? null,
    title: input.title ?? "Untitled session",
    state,
    tool: input.tool ?? "codex",
    branch: input.branch ?? null,
    prUrl: input.prUrl ?? null,
    priority: input.priority ?? "medium",
    statusReason: input.statusReason ?? "",
    createdAt: input.createdAt ?? nowIso(),
    updatedAt: input.updatedAt ?? nowIso(),
    lastUpdate: input.lastUpdate ?? "Queued for execution",
    budget: input.budget ?? { estimatedTokens: 2000, estimatedUsd: 0.4 },
    retryCount: input.retryCount ?? 0,
    maxRetries: input.maxRetries ?? 2,
    lastHeartbeatAt: input.lastHeartbeatAt ?? nowIso(),
    needsRestore: Boolean(input.needsRestore),
    restoreAvailable:
      input.restoreAvailable === undefined
        ? Boolean(input.needsRestore)
        : Boolean(input.restoreAvailable)
  };
}

export function createUserRequest(input = {}) {
  const kind = input.kind ?? "scope_clarification";
  if (!REQUEST_KINDS.includes(kind)) {
    throw new Error(`Unknown request kind: ${kind}`);
  }

  return {
    id: input.id ?? `request_${randomUUID()}`,
    sessionId: input.sessionId ?? null,
    repo: input.repo ?? "unknown/repo",
    title: input.title ?? "Input needed",
    message: input.message ?? "",
    kind,
    status: input.status ?? "open",
    createdAt: input.createdAt ?? nowIso(),
    updatedAt: input.updatedAt ?? nowIso(),
    response: input.response ?? null
  };
}

export function transitionSession(session, nextState, statusReason) {
  if (!SESSION_STATES.includes(nextState)) {
    throw new Error(`Unknown next session state: ${nextState}`);
  }

  return {
    ...session,
    state: nextState,
    statusReason: statusReason ?? session.statusReason,
    updatedAt: nowIso()
  };
}

export const SESSION_EVENT_TYPES = Object.freeze([
  "session.created",
  "session.started",
  "session.state_changed",
  "session.idle",
  "session.waiting_input",
  "session.approval_requested",
  "session.approval_decided",
  "session.failed",
  "session.completed",
  "session.archived",
  "machine.connected",
  "machine.disconnected"
]);

export function createSessionEvent(input = {}) {
  return {
    id: input.id ?? `evt_${randomUUID()}`,
    sessionId: input.sessionId ?? null,
    type: input.type ?? "session.state_changed",
    summary: input.summary ?? "",
    machineId: input.machineId ?? null,
    createdAt: input.createdAt ?? nowIso()
  };
}
