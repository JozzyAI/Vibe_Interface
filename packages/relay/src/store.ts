/**
 * VI Cloud Control Plane — store layer.
 *
 * All read/write operations against the SQLite DB.
 * Returns plain objects whose shapes match the existing dashboard wire format
 * so vi-agent and the dashboard client need zero changes.
 *
 * Design notes:
 * - provider belongs to jobs, not agents.  tool_type on agents is legacy/opaque.
 * - Payload fields (command, handoff, provider_state, etc.) are stored as opaque
 *   text — relay never validates content, enabling E2EE in Phase 2.
 * - Auto-resume / auto-restart logic is ported here so cloud mode is fully
 *   functional without a local dashboard server.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";

// ── Constants (match dashboard values) ────────────────────────────────────────
const USAGE_LIMIT_RETRY_DELAY_MS = 30 * 60 * 1000;
const MAX_AUTO_RESUME_ATTEMPTS = 12;
const MAX_AUTO_RESTART_ATTEMPTS = 4;

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function j(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function pj<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function uid(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function deriveProvider(command: string[]): string {
  const bin = command[1] ?? command[0] ?? "";
  if (bin === "claude") return "claude";
  if (bin === "codex") return "codex";
  return "other";
}

function deriveConnectionState(row: AgentRow): string {
  if (row.connection_state === "disabled") return "disabled";
  const ageMs = Date.now() - new Date(row.last_seen_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 30_000) return row.connection_state ?? "connected";
  if (ageMs < 120_000) return "stale";
  return "disconnected";
}

function containsUsageLimit(text: string): boolean {
  return /usage.?limit|quota.?exceed|rate.?limit|billing/i.test(text);
}

// ── Row type (raw SQLite row) ─────────────────────────────────────────────────

interface AgentRow {
  agent_id: string; owner_id: string; display_name: string; project_label: string;
  tool_type: string | null; host_label: string; repo_root: string | null;
  branch: string | null; worktree: string | null; state_file: string | null;
  log_file: string | null; status: string; permission_mode: string;
  timeout_seconds: number; connection_state: string; consecutive_failures: number;
  last_error: string | null; next_retry_at: string | null; relay_url: string | null;
  relay_connected: number; relay_last_hello_at: string | null; relay_last_error: string | null;
  session_history: string; auth_connectors: string;
  last_seen_at: string; created_at: string;
}

interface JobRow {
  job_id: string; agent_id: string; owner_id: string; provider: string;
  title: string; command: string; cwd: string | null; env: string | null;
  model: string | null; reasoning_effort: string | null;
  status: string; error: string | null; ralph_enabled: number;
  auto_resume_usage_limit: number; auto_restart_codex: number;
  auto_resume_attempts: number; auto_restart_attempts: number;
  next_resume_at: string | null; restart_required_at: string | null;
  restarted_as_job_id: string | null; continued_as_job_id: string | null;
  parent_job_id: string | null; codex_session_id: string | null;
  tmux_session: string | null; exit_code: number | null; pid: number | null;
  log_file: string | null; log_tail: string | null;
  provider_state: string | null; handoff: string | null; artifacts_dir: string | null;
  archived_at: string | null; started_at: string | null; completed_at: string | null;
  created_at: string; updated_at: string;
}

interface ApprovalRow {
  request_id: string; agent_id: string; owner_id: string;
  parent_job_id: string | null; created_job_id: string | null;
  title: string; message: string; risk_level: string;
  command: string | null; action_kind: string | null;
  event_type: string | null; primary_action: string | null;
  status: string; response: string | null; decided_at: string | null;
  created_at: string; updated_at: string;
}

interface EnrollmentRow {
  enrollment_id: string; owner_id: string; code: string;
  display_name: string; project_label: string; tool_type: string | null;
  relay_url: string | null; relay_token: string | null;
  consumed_at: string | null; revoked_at: string | null;
  expires_at: string; created_at: string;
}

interface InputRow {
  input_id: string; job_id: string; agent_id: string;
  text: string; submit: number; key: string | null;
  status: string; created_at: string; sent_at: string | null;
}

// ── Serializers (row → wire object) ──────────────────────────────────────────

function serializeAgent(row: AgentRow) {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    projectLabel: row.project_label,
    toolType: row.tool_type ?? "",
    hostLabel: row.host_label,
    repoRoot: row.repo_root ?? undefined,
    branch: row.branch ?? undefined,
    worktree: row.worktree ?? undefined,
    stateFile: row.state_file ?? undefined,
    logFile: row.log_file ?? undefined,
    status: row.status,
    permissionMode: row.permission_mode,
    timeoutSeconds: row.timeout_seconds,
    connectionState: deriveConnectionState(row),
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error ?? undefined,
    nextRetryAt: row.next_retry_at ?? undefined,
    relay: row.relay_url
      ? {
          url: row.relay_url,
          connected: row.relay_connected === 1,
          lastHelloAt: row.relay_last_hello_at ?? undefined,
          lastError: row.relay_last_error ?? undefined,
        }
      : undefined,
    sessionHistory: pj<unknown[]>(row.session_history, []),
    authConnectors: pj<unknown[]>(row.auth_connectors, []),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function serializeJob(row: JobRow) {
  return {
    jobId: row.job_id,
    agentId: row.agent_id,
    type: "start_agent",
    provider: row.provider,
    title: row.title,
    command: pj<string[]>(row.command, []),
    cwd: row.cwd ?? null,
    env: pj<Record<string, string>>(row.env, {}),
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    ralphEnabled: row.ralph_enabled === 1,
    autoResumeUsageLimit: row.auto_resume_usage_limit === 1,
    autoRestartCodex: row.auto_restart_codex === 1,
    autoResumeAttempts: row.auto_resume_attempts,
    autoRestartAttempts: row.auto_restart_attempts,
    nextResumeAt: row.next_resume_at ?? undefined,
    restartRequiredAt: row.restart_required_at ?? undefined,
    restartedAsJobId: row.restarted_as_job_id ?? undefined,
    continuedAsJobId: row.continued_as_job_id ?? undefined,
    parentJobId: row.parent_job_id ?? undefined,
    codexSessionId: row.codex_session_id ?? undefined,
    tmuxSession: row.tmux_session ?? undefined,
    exitCode: row.exit_code ?? undefined,
    pid: row.pid ?? undefined,
    logFile: row.log_file ?? undefined,
    logTail: row.log_tail ?? undefined,
    providerState: row.provider_state ? pj(row.provider_state, undefined) : undefined,
    handoff: row.handoff ? pj(row.handoff, undefined) : undefined,
    artifactsDir: row.artifacts_dir ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeApproval(row: ApprovalRow) {
  return {
    requestId: row.request_id,
    agentId: row.agent_id,
    parentJobId: row.parent_job_id ?? undefined,
    createdJobId: row.created_job_id ?? undefined,
    title: row.title,
    message: row.message,
    riskLevel: row.risk_level,
    command: row.command ?? null,
    actionKind: row.action_kind ?? undefined,
    eventType: row.event_type ?? "generic",
    primaryAction: row.primary_action ?? "reply",
    status: row.status,
    response: row.response ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeInput(row: InputRow) {
  return {
    inputId: row.input_id,
    jobId: row.job_id,
    text: row.text,
    submit: row.submit === 1,
    key: (row.key as "escape" | undefined) ?? undefined,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
  };
}

function serializeEnrollment(row: EnrollmentRow) {
  return {
    enrollmentId: row.enrollment_id,
    code: row.code,
    displayName: row.display_name,
    projectLabel: row.project_label,
    toolType: row.tool_type ?? "",
    relayUrl: row.relay_url ?? undefined,
    // relayToken intentionally omitted — never include in listing/overview responses.
    // consumeEnrollment reads relay_token directly from the DB row for the config payload.
    consumedAt: row.consumed_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// ── Agent operations ──────────────────────────────────────────────────────────

export function registerAgent(input: {
  agentId?: string; displayName: string; projectLabel: string; toolType?: string;
  hostLabel: string; repoRoot?: string; branch?: string; worktree?: string;
  stateFile?: string; logFile?: string; status?: string; connectionState?: string;
  consecutiveFailures?: number; lastError?: string; nextRetryAt?: string;
  relay?: { url?: string; connected?: boolean; lastHelloAt?: string; lastError?: string };
  sessionHistory?: unknown[]; authConnectors?: unknown[];
}) {
  const db = getDb();
  const t = now();
  const agentId = input.agentId?.trim() || uid("rag");

  // Block re-registration for tombstoned agents. This is the second guard (heartbeatAgent
  // returning shouldStop:true is the primary stop signal; this prevents a race where the
  // daemon calls register before the next heartbeat cycle).
  if (input.agentId?.trim()) {
    const removed = db.prepare("SELECT agent_id FROM removed_agents WHERE agent_id = ?").get(agentId);
    if (removed) throw new Error(`Agent has been permanently removed: ${agentId}. Re-pair to reconnect.`);
  }

  const existing = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow | undefined;

  db.prepare(`
    INSERT INTO agents (
      agent_id, owner_id, display_name, project_label, tool_type,
      host_label, repo_root, branch, worktree, state_file, log_file,
      status, permission_mode, timeout_seconds, connection_state,
      consecutive_failures, last_error, next_retry_at,
      relay_url, relay_connected, relay_last_hello_at, relay_last_error,
      session_history, auth_connectors, last_seen_at, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET
      display_name         = excluded.display_name,
      project_label        = excluded.project_label,
      tool_type            = excluded.tool_type,
      host_label           = excluded.host_label,
      repo_root            = excluded.repo_root,
      branch               = excluded.branch,
      worktree             = excluded.worktree,
      state_file           = COALESCE(excluded.state_file, agents.state_file),
      log_file             = COALESCE(excluded.log_file, agents.log_file),
      status               = excluded.status,
      connection_state     = excluded.connection_state,
      consecutive_failures = excluded.consecutive_failures,
      last_error           = excluded.last_error,
      next_retry_at        = excluded.next_retry_at,
      relay_url            = COALESCE(excluded.relay_url, agents.relay_url),
      relay_connected      = excluded.relay_connected,
      relay_last_hello_at  = excluded.relay_last_hello_at,
      relay_last_error     = excluded.relay_last_error,
      session_history      = CASE WHEN excluded.session_history != '[]' THEN excluded.session_history ELSE agents.session_history END,
      auth_connectors      = CASE WHEN excluded.auth_connectors != '[]' THEN excluded.auth_connectors ELSE agents.auth_connectors END,
      last_seen_at         = excluded.last_seen_at
  `).run(
    agentId, "default",
    input.displayName.trim(), input.projectLabel.trim(), input.toolType?.trim() ?? null,
    (input.hostLabel ?? "").trim(),
    input.repoRoot?.trim() ?? null, input.branch?.trim() ?? null, input.worktree?.trim() ?? null,
    input.stateFile?.trim() ?? null, input.logFile?.trim() ?? null,
    input.status ?? existing?.status ?? "running",
    existing?.permission_mode ?? "manual",
    existing?.timeout_seconds ?? 10,
    input.connectionState ?? existing?.connection_state ?? "connected",
    input.consecutiveFailures ?? existing?.consecutive_failures ?? 0,
    input.lastError ?? null, input.nextRetryAt ?? null,
    input.relay?.url ?? null,
    input.relay?.connected ? 1 : 0,
    input.relay?.lastHelloAt ?? null, input.relay?.lastError ?? null,
    j(input.sessionHistory?.length ? input.sessionHistory : undefined),
    j(input.authConnectors?.length ? input.authConnectors : undefined),
    t,
    existing?.created_at ?? t,
  );

  return serializeAgent(db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow);
}

export function heartbeatAgent(input: {
  agentId: string; status?: string; branch?: string; worktree?: string;
  repoRoot?: string; stateFile?: string; logFile?: string; connectionState?: string;
  consecutiveFailures?: number; lastError?: string; nextRetryAt?: string;
  relay?: { url?: string; connected?: boolean; lastHelloAt?: string; lastError?: string };
  sessionHistory?: unknown[]; authConnectors?: unknown[];
}) {
  const db = getDb();
  const t = now();
  const existing = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(input.agentId) as AgentRow | undefined;
  if (!existing) {
    // If the agent was previously removed, tell the daemon to stop instead of throwing.
    // Pi-agent re-registers on "Unknown remote agent" errors — returning shouldStop:true
    // here causes it to stop cleanly before reaching the re-registration path.
    const removed = db.prepare("SELECT agent_id FROM removed_agents WHERE agent_id = ?").get(input.agentId);
    if (removed) return { agent: null as never, shouldStop: true };
    throw new Error(`Unknown remote agent: ${input.agentId}`);
  }

  db.prepare(`
    UPDATE agents SET
      branch               = COALESCE(?, branch),
      worktree             = COALESCE(?, worktree),
      repo_root            = COALESCE(?, repo_root),
      state_file           = COALESCE(?, state_file),
      log_file             = COALESCE(?, log_file),
      status               = COALESCE(?, status),
      connection_state     = COALESCE(?, connection_state),
      consecutive_failures = COALESCE(?, consecutive_failures),
      last_error           = ?,
      next_retry_at        = ?,
      relay_url            = COALESCE(?, relay_url),
      relay_connected      = COALESCE(?, relay_connected),
      relay_last_hello_at  = COALESCE(?, relay_last_hello_at),
      relay_last_error     = ?,
      session_history      = CASE WHEN ? != '[]' THEN ? ELSE session_history END,
      auth_connectors      = CASE WHEN ? != '[]' THEN ? ELSE auth_connectors END,
      last_seen_at         = ?
    WHERE agent_id = ?
  `).run(
    input.branch?.trim() ?? null,
    input.worktree?.trim() ?? null,
    input.repoRoot?.trim() ?? null,
    input.stateFile?.trim() ?? null,
    input.logFile?.trim() ?? null,
    input.status ?? null,
    input.connectionState ?? null,
    input.consecutiveFailures ?? null,
    input.lastError ?? null,
    input.nextRetryAt ?? null,
    input.relay?.url ?? null,
    input.relay ? (input.relay.connected ? 1 : 0) : null,
    input.relay?.lastHelloAt ?? null,
    input.relay?.lastError ?? null,
    j(input.sessionHistory), j(input.sessionHistory),
    j(input.authConnectors), j(input.authConnectors),
    t,
    input.agentId,
  );

  const updated = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(input.agentId) as AgentRow;
  const shouldStop = updated.connection_state === "disabled";
  return { agent: serializeAgent(updated), shouldStop };
}

export function pollAgent(agentId: string) {
  const db = getDb();
  const t = now();

  const agentRow = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow | undefined;
  if (!agentRow) {
    const removed = db.prepare("SELECT * FROM removed_agents WHERE agent_id = ?").get(agentId);
    if (removed) {
      return {
        agent: { agentId, displayName: "", projectLabel: "", toolType: "", hostLabel: "", status: "paused", permissionMode: "manual", timeoutSeconds: 10, connectionState: "disabled", consecutiveFailures: 0, sessionHistory: [], authConnectors: [], lastSeenAt: t, createdAt: t },
        pendingRequests: [], resolvedRequests: [], pendingJobs: [], jobs: [],
        removedJobIds: [], controlCommands: [],
        shouldStop: true,
      };
    }
    throw new Error(`Unknown remote agent: ${agentId}`);
  }

  // Mark pending control commands as delivered
  const pendingCmds = db.prepare(
    "SELECT * FROM control_commands WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC",
  ).all(agentId) as Array<{ command_id: string; type: string; status: string; created_at: string }>;
  if (pendingCmds.length > 0) {
    const ids = pendingCmds.map(() => "?").join(",");
    db.prepare(`UPDATE control_commands SET status='delivered', delivered_at=? WHERE command_id IN (${ids})`).run(t, ...pendingCmds.map((c) => c.command_id));
  }

  db.prepare("UPDATE agents SET last_seen_at = ? WHERE agent_id = ?").run(t, agentId);

  const allJobs = db.prepare(
    "SELECT * FROM jobs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200",
  ).all(agentId) as JobRow[];

  const pendingJobs = allJobs.filter(
    (j) => j.status === "queued" && !j.archived_at && (!j.next_resume_at || new Date(j.next_resume_at).getTime() <= Date.now()),
  );
  const activeJobs = allJobs.filter((j) => !j.archived_at);
  const removedJobRows = db.prepare(
    "SELECT job_id FROM removed_jobs WHERE agent_id = ?",
  ).all(agentId) as Array<{ job_id: string }>;

  const approvals = db.prepare(
    "SELECT * FROM approval_requests WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100",
  ).all(agentId) as ApprovalRow[];

  // Fetch pending inputs and mark them as sent in one round-trip
  const pendingInputRows = db.prepare(
    "SELECT * FROM job_inputs WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC",
  ).all(agentId) as InputRow[];
  if (pendingInputRows.length > 0) {
    const placeholders = pendingInputRows.map(() => "?").join(",");
    db.prepare(`UPDATE job_inputs SET status = 'sent', sent_at = ? WHERE input_id IN (${placeholders})`).run(
      t, ...pendingInputRows.map((r) => r.input_id),
    );
  }

  // Group inputs by jobId so they can be nested inside each job object.
  // vi-agent's send_pending_inputs() reads job.pendingInputs from the per-job dict.
  const inputsByJobId = new Map<string, InputRow[]>();
  for (const row of pendingInputRows) {
    const list = inputsByJobId.get(row.job_id) ?? [];
    list.push(row);
    inputsByJobId.set(row.job_id, list);
  }

  return {
    agent: serializeAgent(db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow),
    pendingRequests: approvals.filter((r) => r.status === "open").map(serializeApproval),
    resolvedRequests: approvals.filter((r) => r.status !== "open").map(serializeApproval),
    pendingJobs: pendingJobs.map(serializeJob),
    jobs: activeJobs.map((job) => {
      const inputs = inputsByJobId.get(job.job_id) ?? [];
      const serialized = serializeJob(job);
      return inputs.length > 0 ? { ...serialized, pendingInputs: inputs.map(serializeInput) } : serialized;
    }),
    removedJobIds: removedJobRows.map((r) => r.job_id),
    controlCommands: pendingCmds.map((c) => ({ commandId: c.command_id, agentId, type: c.type, status: "delivered", createdAt: c.created_at, deliveredAt: t })),
    pendingInputs: pendingInputRows.map(serializeInput),
  };
}

// ── Job operations ────────────────────────────────────────────────────────────

export function createJob(input: {
  agentId: string; title?: string; command: string[]; provider?: string;
  cwd?: string; env?: Record<string, string>; model?: string | null;
  reasoningEffort?: string | null; ralphEnabled?: boolean;
  autoResumeUsageLimit?: boolean; autoRestartCodex?: boolean;
}) {
  const db = getDb();
  const agent = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(input.agentId);
  if (!agent) throw new Error(`Unknown remote agent: ${input.agentId}`);

  const cmd = input.command.filter(Boolean);
  if (cmd.length === 0) throw new Error("Job requires a non-empty command");

  const t = now();
  const jobId = uid("raj");
  const provider = input.provider?.trim() || deriveProvider(cmd);

  db.prepare(`
    INSERT INTO jobs (
      job_id, agent_id, owner_id, provider, title, command, cwd, env,
      model, reasoning_effort, status, ralph_enabled,
      auto_resume_usage_limit, auto_restart_codex,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    jobId, input.agentId, "default", provider,
    input.title?.trim() || `Start ${cmd[0] ?? "job"}`,
    j(cmd), input.cwd?.trim() ?? null, j(input.env ?? {}),
    input.model?.trim() ?? null, input.reasoningEffort?.trim() ?? null,
    "queued",
    input.ralphEnabled ? 1 : 0,
    input.autoResumeUsageLimit ? 1 : 0,
    input.autoRestartCodex ? 1 : 0,
    t, t,
  );

  return serializeJob(db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow);
}

export function reportJob(input: {
  agentId: string; jobId: string; status: string;
  pid?: number; tmuxSession?: string; exitCode?: number;
  logFile?: string; logTail?: string; providerState?: unknown;
  artifactsDir?: string; handoffTitle?: string;
  progress?: string; todo?: string; notes?: string; error?: string;
}) {
  const db = getDb();
  const t = now();

  let row = db.prepare("SELECT * FROM jobs WHERE job_id = ? AND agent_id = ?").get(input.jobId, input.agentId) as JobRow | undefined;

  if (!row) {
    const removed = db.prepare("SELECT job_id FROM removed_jobs WHERE job_id = ?").get(input.jobId);
    if (removed) throw new Error(`Remote agent job was removed: ${input.jobId}`);
    const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(input.agentId) as AgentRow | undefined;
    if (!agent) throw new Error(`Unknown remote agent: ${input.agentId}`);
    // Recover orphaned job
    db.prepare(`
      INSERT INTO jobs (job_id, agent_id, owner_id, provider, title, command, status, created_at, updated_at)
      VALUES (?, ?, 'default', 'other', ?, '[]', ?, ?, ?)
    `).run(input.jobId, input.agentId, `Recovered: ${input.jobId.slice(-8)}`, input.status, t, t);
    row = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(input.jobId) as JobRow;
  }

  // Build handoff JSON if progress/todo/notes provided
  let handoffJson = row.handoff;
  if (input.progress !== undefined || input.todo !== undefined || input.notes !== undefined || input.handoffTitle !== undefined) {
    const existing = pj<Record<string, unknown>>(row.handoff, {});
    const updated = {
      ...existing,
      ...(input.handoffTitle !== undefined ? { title: input.handoffTitle } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.todo !== undefined ? { todo: input.todo } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: t,
    };
    handoffJson = j(updated);
  }

  const startedAt = input.status === "running" && !row.started_at ? t : row.started_at;
  const completedAt =
    (input.status === "completed" || input.status === "failed") && !row.completed_at ? t : row.completed_at;

  db.prepare(`
    UPDATE jobs SET
      status        = ?,
      error         = COALESCE(?, error),
      pid           = COALESCE(?, pid),
      tmux_session  = COALESCE(?, tmux_session),
      exit_code     = COALESCE(?, exit_code),
      log_file      = COALESCE(?, log_file),
      log_tail      = COALESCE(?, log_tail),
      provider_state = COALESCE(?, provider_state),
      artifacts_dir  = COALESCE(?, artifacts_dir),
      handoff       = COALESCE(?, handoff),
      started_at    = ?,
      completed_at  = ?,
      updated_at    = ?
    WHERE job_id = ?
  `).run(
    input.status,
    input.error ?? null,
    input.pid ?? null,
    input.tmuxSession ?? null,
    input.exitCode ?? null,
    input.logFile ?? null,
    input.logTail ?? null,
    input.providerState != null ? j(input.providerState) : null,
    input.artifactsDir ?? null,
    handoffJson,
    startedAt,
    completedAt,
    t,
    input.jobId,
  );

  const updated = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(input.jobId) as JobRow;

  // Auto-resume logic (port of dashboard maybeQueueUsageLimitResume)
  if (input.status === "failed" || input.status === "completed") {
    maybeQueueResume(db, updated, t);
  }

  return serializeJob(updated);
}

function maybeQueueResume(db: ReturnType<typeof getDb>, job: JobRow, t: string): void {
  const cmd = pj<string[]>(job.command, []);

  // Usage-limit auto-resume
  if (job.auto_resume_usage_limit === 1 && job.status === "failed" && cmd.length > 0) {
    const attempts = job.auto_resume_attempts;
    if (attempts < MAX_AUTO_RESUME_ATTEMPTS) {
      const errorText = `${job.error ?? ""}\n${job.log_tail ?? ""}`;
      if (containsUsageLimit(errorText)) {
        const hasChild = db.prepare(
          "SELECT job_id FROM jobs WHERE parent_job_id = ? AND archived_at IS NULL AND status IN ('queued','running')",
        ).get(job.job_id);
        if (!hasChild) {
          const nextResumeAt = new Date(Date.now() + USAGE_LIMIT_RETRY_DELAY_MS).toISOString();
          const childId = uid("raj");
          db.prepare(`
            INSERT INTO jobs (
              job_id, agent_id, owner_id, provider, title, command, cwd, env,
              model, reasoning_effort, status, ralph_enabled,
              auto_resume_usage_limit, auto_restart_codex,
              auto_resume_attempts, next_resume_at, parent_job_id,
              created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            childId, job.agent_id, "default", job.provider,
            `${job.title} (auto resume ${attempts + 1})`,
            job.command, job.cwd, job.env,
            job.model, job.reasoning_effort,
            "queued", job.ralph_enabled,
            1, job.auto_restart_codex,
            attempts + 1, nextResumeAt, job.job_id,
            t, t,
          );
          db.prepare("UPDATE jobs SET auto_resume_attempts = ?, updated_at = ? WHERE job_id = ?").run(attempts + 1, t, job.job_id);
        }
      }
    }
  }

  // Codex auto-restart
  if (job.auto_restart_codex === 1 && job.status === "failed" && cmd.length > 0) {
    const attempts = job.auto_restart_attempts;
    if (attempts < MAX_AUTO_RESTART_ATTEMPTS) {
      const hasChild = db.prepare(
        "SELECT job_id FROM jobs WHERE parent_job_id = ? AND archived_at IS NULL AND status IN ('queued','running')",
      ).get(job.job_id);
      if (!hasChild) {
        const childId = uid("raj");
        db.prepare(`
          INSERT INTO jobs (
            job_id, agent_id, owner_id, provider, title, command, cwd, env,
            model, reasoning_effort, status, ralph_enabled,
            auto_resume_usage_limit, auto_restart_codex,
            auto_restart_attempts, parent_job_id,
            created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          childId, job.agent_id, "default", job.provider,
          `${job.title} (auto restart ${attempts + 1})`,
          job.command, job.cwd, job.env,
          job.model, job.reasoning_effort,
          "queued", job.ralph_enabled,
          job.auto_resume_usage_limit, 1,
          attempts + 1, job.job_id,
          t, t,
        );
        db.prepare("UPDATE jobs SET auto_restart_attempts = ?, updated_at = ? WHERE job_id = ?").run(attempts + 1, t, job.job_id);
      }
    }
  }
}

export function archiveJob(jobId: string, agentId?: string) {
  const db = getDb();
  const t = now();
  const row = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  if (!row) throw new Error(`Unknown job: ${jobId}`);
  if (agentId && row.agent_id !== agentId) throw new Error(`Job ${jobId} does not belong to agent ${agentId}`);
  db.prepare("UPDATE jobs SET archived_at = ?, updated_at = ? WHERE job_id = ?").run(t, t, jobId);
  return serializeJob(db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow);
}

export function removeJob(jobId: string, agentId?: string) {
  const db = getDb();
  const t = now();
  const row = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  if (!row) throw new Error(`Unknown job: ${jobId}`);
  if (agentId && row.agent_id !== agentId) throw new Error(`Job ${jobId} does not belong to agent ${agentId}`);
  // Collect child jobs
  const children = db.prepare("SELECT job_id FROM jobs WHERE parent_job_id = ?").all(jobId) as Array<{ job_id: string }>;
  const allIds = [jobId, ...children.map((c) => c.job_id)];
  for (const id of allIds) {
    db.prepare("DELETE FROM jobs WHERE job_id = ?").run(id);
    db.prepare("INSERT OR REPLACE INTO removed_jobs (job_id, agent_id, removed_at) VALUES (?,?,?)").run(id, row.agent_id, t);
  }
  return { removedJobIds: allIds };
}

export function restartJob(jobId: string, agentId?: string) {
  const db = getDb();
  const t = now();
  const row = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  if (!row) throw new Error(`Unknown job: ${jobId}`);
  if (agentId && row.agent_id !== agentId) throw new Error(`Job ${jobId} does not belong to agent ${agentId}`);

  const cmd = pj<string[]>(row.command, []);
  if (cmd.length === 0) throw new Error("Cannot restart a job with no command");

  const childId = uid("raj");
  db.prepare(`
    INSERT INTO jobs (
      job_id, agent_id, owner_id, provider, title, command, cwd, env,
      model, reasoning_effort, status, ralph_enabled,
      auto_resume_usage_limit, auto_restart_codex,
      parent_job_id, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    childId, row.agent_id, "default", row.provider,
    `Restart: ${row.title.replace(/^Restart:\s*/i, "").slice(0, 64)}`,
    row.command, row.cwd, row.env,
    row.model, row.reasoning_effort,
    "queued", row.ralph_enabled, row.auto_resume_usage_limit, row.auto_restart_codex,
    jobId, t, t,
  );
  db.prepare("UPDATE jobs SET restarted_as_job_id = ?, updated_at = ? WHERE job_id = ?").run(childId, t, jobId);
  return serializeJob(db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(childId) as JobRow);
}

// ── Job input operations ──────────────────────────────────────────────────────

export function queueJobInput(
  jobId: string,
  input: { text: string; submit?: boolean; key?: "escape" },
) {
  const db = getDb();
  const job = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  const inputId = uid("inp");
  const t = now();
  db.prepare(`
    INSERT INTO job_inputs (input_id, job_id, agent_id, text, submit, key, status, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    inputId, jobId, job.agent_id,
    input.text.trim(), input.submit !== false ? 1 : 0,
    input.key ?? null, "pending", t,
  );
  db.prepare("UPDATE jobs SET updated_at = ? WHERE job_id = ?").run(t, jobId);
  return serializeJob(db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow);
}

// ── Approval operations ───────────────────────────────────────────────────────

export function createApprovalRequest(input: {
  agentId: string; parentJobId?: string; title: string; message: string;
  riskLevel?: string; command?: string; actionKind?: string;
  eventType?: string; primaryAction?: string;
}) {
  const db = getDb();
  const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(input.agentId) as AgentRow | undefined;
  if (!agent) throw new Error(`Unknown remote agent: ${input.agentId}`);

  const t = now();
  const requestId = uid("rar");
  const permissionMode = agent.permission_mode;
  const risk = input.riskLevel ?? "medium";

  // Auto-approve based on permission mode
  let status = "open";
  if (permissionMode === "always_allow") status = "approved";
  else if (permissionMode === "timeout_allow" && risk !== "high" && risk !== "critical") status = "approved";

  db.prepare(`
    INSERT INTO approval_requests (
      request_id, agent_id, owner_id, parent_job_id, title, message,
      risk_level, command, action_kind, event_type, primary_action,
      status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    requestId, input.agentId, "default",
    input.parentJobId?.trim() ?? null,
    input.title.trim(), input.message.trim(),
    risk, input.command?.trim() ?? null, input.actionKind ?? null,
    input.eventType ?? (input.command?.trim() ? "command" : "generic"),
    input.primaryAction ?? (input.command?.trim() ? "approve" : "reply"),
    status, t, t,
  );

  if (status === "open") {
    db.prepare("UPDATE agents SET status = 'awaiting_approval', last_seen_at = ? WHERE agent_id = ?").run(t, input.agentId);
  }

  return serializeApproval(db.prepare("SELECT * FROM approval_requests WHERE request_id = ?").get(requestId) as ApprovalRow);
}

export function respondToApproval(requestId: string, action: string, response?: string) {
  const db = getDb();
  const t = now();
  const row = db.prepare("SELECT * FROM approval_requests WHERE request_id = ?").get(requestId) as ApprovalRow | undefined;
  if (!row) throw new Error(`Unknown approval request: ${requestId}`);

  const newStatus = action === "approve" ? "approved" : "rejected";
  db.prepare(`
    UPDATE approval_requests SET status = ?, response = ?, decided_at = ?, updated_at = ?
    WHERE request_id = ?
  `).run(newStatus, response?.trim() ?? null, t, t, requestId);

  // Update agent status if no more open approvals
  const stillOpen = db.prepare(
    "SELECT COUNT(*) AS cnt FROM approval_requests WHERE agent_id = ? AND status = 'open'",
  ).get(row.agent_id) as { cnt: number };
  const agentStatus = (stillOpen.cnt ?? 0) > 0 ? "awaiting_approval" : "running";
  db.prepare("UPDATE agents SET status = ?, last_seen_at = ? WHERE agent_id = ?").run(agentStatus, t, row.agent_id);

  return serializeApproval(db.prepare("SELECT * FROM approval_requests WHERE request_id = ?").get(requestId) as ApprovalRow);
}

// ── Enrollment operations ─────────────────────────────────────────────────────

export function createEnrollment(input: {
  displayName: string; projectLabel: string; toolType?: string;
  expiresInMinutes?: number; relayUrl?: string; relayToken?: string;
}) {
  const db = getDb();
  const t = now();
  const enrollmentId = uid("ren");
  const code = randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
  const expiresAt = new Date(Date.now() + (input.expiresInMinutes ?? 60) * 60_000).toISOString();

  // Derive relay URL and token from env if not provided
  const relayUrl = input.relayUrl ?? deriveRelayPublicWsUrl() ?? null;
  const relayToken = input.relayToken ?? process.env["VI_RELAY_DAEMON_TOKEN"]?.trim() ?? daemonTokenFromRelayTokens() ?? null;

  db.prepare(`
    INSERT INTO enrollments (
      enrollment_id, owner_id, code, display_name, project_label, tool_type,
      relay_url, relay_token, expires_at, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    enrollmentId, "default", code,
    input.displayName.trim(), input.projectLabel.trim(),
    input.toolType?.trim() ?? null,
    relayUrl, relayToken, expiresAt, t,
  );

  return serializeEnrollment(db.prepare("SELECT * FROM enrollments WHERE enrollment_id = ?").get(enrollmentId) as EnrollmentRow);
}

export function consumeEnrollment(code: string) {
  const db = getDb();
  const t = now();
  const normalized = code.trim().toUpperCase();
  const row = db.prepare("SELECT * FROM enrollments WHERE code = ?").get(normalized) as EnrollmentRow | undefined;
  if (!row) throw new Error("Unknown enrollment code");
  if (row.revoked_at) throw new Error("Enrollment code has been revoked");
  if (row.consumed_at) throw new Error("Enrollment code has already been used");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error("Enrollment code has expired");

  db.prepare("UPDATE enrollments SET consumed_at = ? WHERE enrollment_id = ?").run(t, row.enrollment_id);

  const updated = serializeEnrollment(db.prepare("SELECT * FROM enrollments WHERE enrollment_id = ?").get(row.enrollment_id) as EnrollmentRow);
  return {
    enrollment: updated,
    config: {
      displayName: row.display_name,
      projectLabel: row.project_label,
      toolType: row.tool_type ?? "",
      relayUrl: row.relay_url ?? undefined,
      relayToken: row.relay_token ?? undefined,
    },
  };
}

export function revokeEnrollment(enrollmentId: string) {
  const db = getDb();
  const t = now();
  const row = db.prepare("SELECT * FROM enrollments WHERE enrollment_id = ?").get(enrollmentId) as EnrollmentRow | undefined;
  if (!row) throw new Error(`Unknown enrollment: ${enrollmentId}`);
  db.prepare("UPDATE enrollments SET revoked_at = ? WHERE enrollment_id = ?").run(t, enrollmentId);
  return serializeEnrollment(db.prepare("SELECT * FROM enrollments WHERE enrollment_id = ?").get(enrollmentId) as EnrollmentRow);
}

export function listActiveEnrollments() {
  const db = getDb();
  const t = new Date().toISOString();
  const rows = db.prepare(
    "SELECT * FROM enrollments WHERE revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
  ).all(t) as EnrollmentRow[];
  return rows.map(serializeEnrollment);
}

export function listRecentEnrollments(limit = 12) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM enrollments ORDER BY created_at DESC LIMIT ?",
  ).all(limit) as EnrollmentRow[];
  return rows.map(serializeEnrollment);
}

function normalizeRelayTerminalWsUrl(relayUrl: string): string {
  // Strip /ws or /vi-agent-relay suffix, then append /vi-agent-relay
  const base = relayUrl
    .replace(/\/vi-agent-relay$/, "")
    .replace(/\/ws$/, "")
    .replace(/\/$/, "");
  // Convert http(s) → ws(s) if needed
  const ws = base.startsWith("http://") ? "ws://" + base.slice(7)
    : base.startsWith("https://") ? "wss://" + base.slice(8)
    : base;
  return `${ws}/vi-agent-relay`;
}

function buildPairCommands(enrollment: ReturnType<typeof serializeEnrollment>) {
  const relayPublicUrl = deriveRelayPublicHttpUrl();

  // If relay env vars are not set, generate a clear config-error placeholder rather
  // than silently producing a pair command pointing at localhost:3000.
  const serverOrigin = relayPublicUrl ?? null;
  if (!serverOrigin) {
    const errCmd = "# ERROR: VI_RELAY_BASE_URL (or VI_RELAY_PUBLIC_WS_URL) not set on relay — cannot generate pair command";
    return { pairCommand: errCmd, advancedCommand: errCmd, relayUrl: enrollment.relayUrl ?? "" };
  }

  const pairCommand = `vi-agent pair --server ${serverOrigin} --code ${enrollment.code} --start`;
  const advancedCommand = enrollment.relayUrl
    ? `VI_TERMINAL_RELAY_URL=${normalizeRelayTerminalWsUrl(enrollment.relayUrl)} \\\n  ${pairCommand}`
    : pairCommand;
  return { pairCommand, advancedCommand, relayUrl: enrollment.relayUrl ?? "" };
}

export function createEnrollmentWithPairCommand(input: {
  displayName: string; projectLabel: string; toolType?: string; expiresInMinutes?: number;
}) {
  const enrollment = createEnrollment(input);
  return { enrollment, ...buildPairCommands(enrollment) };
}

export function createReconnectEnrollment(agentId: string) {
  const db = getDb();
  const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow | undefined;
  if (!agent) throw new Error(`Unknown remote agent: ${agentId}`);

  const enrollment = createEnrollment({
    displayName: agent.display_name,
    projectLabel: agent.project_label,
    toolType: agent.tool_type ?? undefined,
    expiresInMinutes: 60,
  });

  return { enrollment, ...buildPairCommands(enrollment) };
}

// ── Agent policy ──────────────────────────────────────────────────────────────

export function setAgentPolicy(input: {
  agentId: string;
  mode?: "manual" | "timeout_allow" | "always_allow";
  timeoutSeconds?: number;
}) {
  const db = getDb();
  const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(input.agentId) as AgentRow | undefined;
  if (!agent) throw new Error(`Unknown remote agent: ${input.agentId}`);
  const mode = input.mode ?? agent.permission_mode;
  const timeout = typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0
    ? Math.floor(input.timeoutSeconds)
    : agent.timeout_seconds;
  db.prepare("UPDATE agents SET permission_mode = ?, timeout_seconds = ? WHERE agent_id = ?")
    .run(mode, timeout, input.agentId);
  return serializeAgent(db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(input.agentId) as AgentRow);
}

// ── Agent management ──────────────────────────────────────────────────────────

export function removeAgent(agentId: string) {
  const db = getDb();
  const t = now();
  const agent = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(agentId) as { agent_id: string } | undefined;
  if (!agent) {
    // Already removed — idempotent success. Check removed_agents to distinguish from truly unknown.
    const wasRemoved = db.prepare("SELECT agent_id FROM removed_agents WHERE agent_id = ?").get(agentId);
    if (wasRemoved) return; // already gone, goal achieved
    throw new Error(`Unknown remote agent: ${agentId}`);
  }

  const jobs = db.prepare("SELECT job_id FROM jobs WHERE agent_id = ?").all(agentId) as Array<{ job_id: string }>;
  for (const { job_id } of jobs) {
    db.prepare("DELETE FROM jobs WHERE job_id = ?").run(job_id);
    db.prepare("INSERT OR REPLACE INTO removed_jobs (job_id, agent_id, removed_at) VALUES (?,?,?)").run(job_id, agentId, t);
  }
  db.prepare("DELETE FROM agents WHERE agent_id = ?").run(agentId);
  db.prepare("INSERT OR REPLACE INTO removed_agents (agent_id, removed_at) VALUES (?,?)").run(agentId, t);
}

export function requestDaemonRestart(agentId: string) {
  const db = getDb();
  const agent = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(agentId);
  if (!agent) throw new Error(`Unknown remote agent: ${agentId}`);
  const commandId = uid("cmd");
  db.prepare(
    "INSERT INTO control_commands (command_id, agent_id, type, status, created_at) VALUES (?,?,?,?,?)",
  ).run(commandId, agentId, "restart_daemon", "pending", now());
  return { commandId, agentId, type: "restart_daemon" };
}

// ── Overview ──────────────────────────────────────────────────────────────────

export function getOverview() {
  const db = getDb();
  const t = now();

  const agents = (db.prepare("SELECT * FROM agents ORDER BY last_seen_at DESC").all() as AgentRow[]).map((row) => {
    const openCount = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM approval_requests WHERE agent_id = ? AND status = 'open'",
    ).get(row.agent_id) as { cnt: number }).cnt;
    return { ...serializeAgent(row), pendingApprovalCount: openCount };
  });

  const requests = db.prepare(
    "SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT 500",
  ).all() as ApprovalRow[];

  const jobs = db.prepare(
    "SELECT * FROM jobs WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 500",
  ).all() as JobRow[];

  const activeEnrollments = db.prepare(
    "SELECT * FROM enrollments WHERE revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
  ).all(t) as EnrollmentRow[];

  const recentEnrollments = db.prepare(
    "SELECT * FROM enrollments ORDER BY created_at DESC LIMIT 12",
  ).all() as EnrollmentRow[];

  return {
    generatedAt: t,
    stats: {
      agents: agents.length,
      running: agents.filter((a) => a.status === "running").length,
      pending: requests.filter((r) => r.status === "open").length,
      failed: agents.filter((a) => a.status === "failed").length,
    },
    agents,
    requests: requests.map(serializeApproval),
    jobs: jobs.map(serializeJob),
    events: [],
    enrollments: activeEnrollments.map(serializeEnrollment),
    recentEnrollments: recentEnrollments.map(serializeEnrollment),
  };
}

// ── Helpers for relay URL derivation ─────────────────────────────────────────

function deriveRelayPublicWsUrl(): string | null {
  const raw = (
    process.env["VI_RELAY_PUBLIC_WS_URL"] ??
    process.env["VI_RELAY_URL"] ??
    process.env["VI_RELAY_BASE_URL"] ??
    ""
  ).trim().replace(/\/$/, "");
  if (!raw) return null;
  let url = raw.startsWith("http://") ? "ws://" + raw.slice(7)
    : raw.startsWith("https://") ? "wss://" + raw.slice(8)
    : raw;
  if (!url.endsWith("/ws")) url = `${url}/ws`;
  return url;
}

function deriveRelayPublicHttpUrl(): string | null {
  const raw = (
    process.env["VI_RELAY_PUBLIC_WS_URL"] ??
    process.env["VI_RELAY_URL"] ??
    process.env["VI_RELAY_BASE_URL"] ??
    ""
  ).trim().replace(/\/$/, "");
  if (!raw) return null;
  return raw.startsWith("ws://") ? "http://" + raw.slice(5)
    : raw.startsWith("wss://") ? "https://" + raw.slice(6)
    : raw;
}

function daemonTokenFromRelayTokens(): string | null {
  const raw = process.env["VI_RELAY_TOKENS"]?.trim();
  if (!raw) return null;
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    const token = parts[0] ?? "";
    const kind = parts[1] ?? "";
    if (token && kind === "daemon") return token;
  }
  return null;
}
