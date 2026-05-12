import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  PIApprovalEventType,
  PIApprovalPrimaryAction,
  PIApprovalPermissionMode,
  PIApprovalRiskLevel,
  PIExternalActionKind,
  RemoteAgentConnectionState,
  RemoteAuthConnectorSummary,
  RemoteAgentStatus,
  RemoteAgentJob,
  RemoteAgentEvent,
  RemoteAgentEventType,
  RemoteAgentSessionHistoryItem,
  RemoteAgentSummary,
  RemoteRelayState,
  RemoteApprovalOverview,
  RemoteApprovalRequest,
  RemoteEnrollmentSummary,
} from "@/lib/types";
import { getServices } from "@/lib/services";

interface RemoteAgentRecord {
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
  permissionMode: PIApprovalPermissionMode;
  timeoutSeconds: number;
  connectionState: RemoteAgentConnectionState;
  consecutiveFailures: number;
  lastError?: string;
  nextRetryAt?: string;
  relay?: RemoteRelayState;
  sessionHistory?: RemoteAgentSessionHistoryItem[];
  authConnectors?: RemoteAuthConnectorSummary[];
  lastSeenAt: string;
  createdAt: string;
}

type RemoteApprovalRequestRecord = RemoteApprovalRequest;

interface RemoteEnrollmentRecord extends RemoteEnrollmentSummary {
  relayUrl?: string;
  relayToken?: string;
}

function serializeEnrollment(entry: RemoteEnrollmentRecord): RemoteEnrollmentSummary {
  return {
    enrollmentId: entry.enrollmentId,
    code: entry.code,
    displayName: entry.displayName,
    projectLabel: entry.projectLabel,
    toolType: entry.toolType,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    consumedAt: entry.consumedAt,
    revokedAt: entry.revokedAt,
  };
}

interface RemoteAgentStore {
  agents: RemoteAgentRecord[];
  requests: RemoteApprovalRequestRecord[];
  jobs: RemoteAgentJob[];
  events: RemoteAgentEvent[];
  enrollments: RemoteEnrollmentRecord[];
}

const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_REMOTE_EVENTS = 2_000;
const USAGE_LIMIT_RETRY_DELAY_MS = 30 * 60 * 1000;
const MAX_AUTO_RESUME_ATTEMPTS = 12;
const MAX_AUTO_RESTART_ATTEMPTS = 4;
const DEFAULT_RALPH_MAX_ITERATIONS = 12;

function defaultStore(): RemoteAgentStore {
  return {
    agents: [],
    requests: [],
    jobs: [],
    events: [],
    enrollments: [],
  };
}

let lastGoodStore: RemoteAgentStore | null = null;

async function storePath(): Promise<string> {
  const { config } = await getServices();
  return join(dirname(config.configPath), "pi-remote-agents", "state.json");
}

async function readStore(): Promise<RemoteAgentStore> {
  try {
    const raw = await readFile(await storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RemoteAgentStore>;
    const store = {
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      enrollments: Array.isArray(parsed.enrollments) ? parsed.enrollments : [],
    };
    lastGoodStore = store;
    return store;
  } catch {
    return lastGoodStore ?? defaultStore();
  }
}

async function writeStore(store: RemoteAgentStore): Promise<void> {
  const path = await storePath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await rename(tempPath, path);
  lastGoodStore = store;
}

function appendRemoteEvent(
  store: RemoteAgentStore,
  input: {
    type: RemoteAgentEventType;
    agentId?: string;
    jobId?: string;
    requestId?: string;
    severity?: RemoteAgentEvent["severity"];
    metadata?: RemoteAgentEvent["metadata"];
    createdAt?: string;
  },
): RemoteAgentEvent {
  const event: RemoteAgentEvent = {
    eventId: `rae_${randomUUID()}`,
    type: input.type,
    createdAt: input.createdAt ?? new Date().toISOString(),
    agentId: input.agentId,
    jobId: input.jobId,
    requestId: input.requestId,
    severity: input.severity ?? "info",
    metadata: input.metadata,
  };
  store.events = [event, ...(store.events ?? [])].slice(0, MAX_REMOTE_EVENTS);
  return event;
}

function cycleMode(mode: PIApprovalPermissionMode): PIApprovalPermissionMode {
  if (mode === "manual") return "timeout_allow";
  if (mode === "timeout_allow") return "always_allow";
  return "manual";
}

function normalizeSessionHistory(
  sessions: RemoteAgentSessionHistoryItem[] | undefined,
): RemoteAgentSessionHistoryItem[] | undefined {
  if (!Array.isArray(sessions)) return undefined;
  return sessions
    .map((session) => ({
      sessionId: String(session.sessionId ?? "").trim(),
      label: String(session.label ?? "").trim(),
      path: String(session.path ?? "").trim(),
      messagePreview: session.messagePreview ? String(session.messagePreview).trim() : undefined,
      lastActivityPreview: session.lastActivityPreview
        ? String(session.lastActivityPreview).trim()
        : undefined,
      cwd: session.cwd ? String(session.cwd).trim() : undefined,
      createdAt: session.createdAt ? String(session.createdAt).trim() : undefined,
      updatedAt: String(session.updatedAt ?? "").trim(),
      source: session.source ? String(session.source).trim() : undefined,
      cliVersion: session.cliVersion ? String(session.cliVersion).trim() : undefined,
      model: session.model ? String(session.model).trim() : undefined,
      eventCount:
        typeof session.eventCount === "number" && Number.isFinite(session.eventCount)
          ? Math.max(0, Math.floor(session.eventCount))
          : undefined,
    }))
    .filter((session) => session.sessionId && session.path && session.updatedAt)
    .slice(0, 30);
}

function normalizeAuthConnectors(
  connectors: RemoteAuthConnectorSummary[] | undefined,
): RemoteAuthConnectorSummary[] | undefined {
  if (!Array.isArray(connectors)) return undefined;
  return connectors
    .map((connector) => {
      const status = ["connected", "missing", "disconnected", "unknown"].includes(
        String(connector.status),
      )
        ? connector.status
        : "unknown";
      const kind = ["github", "npm", "docker", "ssh", "custom"].includes(String(connector.kind))
        ? connector.kind
        : "custom";
      return {
        connectorId: String(connector.connectorId ?? "").trim(),
        kind,
        label: String(connector.label ?? "").trim(),
        status,
        detail: connector.detail ? String(connector.detail).trim() : undefined,
        account: connector.account ? String(connector.account).trim() : undefined,
        checkedAt: String(connector.checkedAt ?? "").trim(),
      };
    })
    .filter((connector) => connector.connectorId && connector.label && connector.checkedAt)
    .slice(0, 12);
}

function applyAutoPolicy(agent: RemoteAgentRecord, request: RemoteApprovalRequestRecord): boolean {
  if (request.status !== "open") return false;
  if (agent.permissionMode === "always_allow") {
    request.status = "approved";
    request.response = "Auto-approved by remote agent policy.";
    request.updatedAt = new Date().toISOString();
    return true;
  }
  if (agent.permissionMode === "timeout_allow") {
    const ageMs = Date.now() - new Date(request.createdAt).getTime();
    if (ageMs >= agent.timeoutSeconds * 1000) {
      request.status = "approved";
      request.response = `Auto-approved after ${agent.timeoutSeconds}s timeout.`;
      request.updatedAt = new Date().toISOString();
      return true;
    }
  }
  return false;
}

function containsUsageLimit(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("you've hit your usage limit") ||
    lower.includes("you have hit your usage limit") ||
    lower.includes("hit your usage limit") ||
    lower.includes("usage limit")
  );
}

function needsCodexRestart(text: string | undefined): boolean {
  return (text ?? "").toLowerCase().includes("please restart codex");
}

function stripAnsi(input: string): string {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  return input
    .replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, "g"), "")
    .replace(new RegExp(`${esc}[PX^_].*?${esc}\\\\`, "gs"), "")
    .replace(new RegExp(`${esc}[@-_]`, "g"), "");
}

function commandCwd(command: string[] | undefined): string | undefined {
  const index = command?.indexOf("--cwd") ?? -1;
  if (index < 0) return undefined;
  return command?.[index + 1];
}

function pathBasename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop();
}

function findResumeCandidate(
  agent: RemoteAgentRecord | undefined,
  job: RemoteAgentJob,
): RemoteAgentSessionHistoryItem | undefined {
  const sessions = agent?.sessionHistory ?? [];
  if (sessions.length === 0) return undefined;

  const storedSessionId = job.codexSessionId ?? job.env?.PI_CODEX_SESSION_ID;
  if (storedSessionId) {
    const exact = sessions.find((session) => session.sessionId === storedSessionId);
    if (exact) return exact;
  }

  const cwd = job.cwd ?? commandCwd(job.command) ?? agent?.worktree ?? agent?.repoRoot;
  if (cwd) {
    const exactCwd = sessions.find((session) => session.cwd === cwd);
    if (exactCwd) return exactCwd;
  }

  const logTail = job.logTail ?? "";
  const logMatch = sessions.find((session) => {
    if (session.cwd && logTail.includes(session.cwd)) return true;
    const leaf = pathBasename(session.cwd);
    return Boolean(leaf && logTail.includes(leaf));
  });
  if (logMatch) return logMatch;

  return sessions[0];
}

function codexModelArgs(options: {
  model?: string | null;
  reasoningEffort?: string | null;
}): string[] {
  const args: string[] = [];
  const model = options.model?.trim();
  const reasoningEffort = options.reasoningEffort?.trim();
  if (model) args.push("-m", model);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  return args;
}

function buildCodexResumeCommand(
  candidate: RemoteAgentSessionHistoryItem,
  cwd: string,
  options: { model?: string | null; reasoningEffort?: string | null } = {},
): string[] {
  return [
    "pi-agent",
    "codex",
    "--cwd",
    cwd,
    "--",
    ...codexModelArgs(options),
    "resume",
    candidate.sessionId,
  ];
}

function ralphTaskSeed(job: RemoteAgentJob): string {
  const envTitle = job.env?.PI_SESSION_TITLE?.trim();
  if (envTitle) return envTitle;
  return job.title.replace(/\s+\(ralph iteration \d+\)$/i, "").trim() || "PI task";
}

function containsRalphComplete(text: string | undefined): boolean {
  const clean = stripAnsi(text ?? "");
  return /(^|\n)\s*COMPLETE\s*($|\n)/i.test(clean);
}

function buildRalphIterationPrompt(job: RemoteAgentJob, iteration: number): string {
  const taskTitle = ralphTaskSeed(job);
  return [
    `PI True Ralph mode iteration ${iteration} for: ${taskTitle}`,
    "",
    "Run one bounded autonomous iteration, then exit.",
    "",
    "Rules:",
    "- Inspect the current repository/workspace state before changing files.",
    "- Pick exactly one useful next step that moves this task forward.",
    "- Keep edits small and verifiable.",
    "- If you need user input, approval, credentials, or an external blocker is reached, stop and explain the blocker.",
    "- If you make progress, summarize what changed and how you verified it.",
    "- Print COMPLETE on its own line only when the whole task is finished.",
    "- Otherwise print CONTINUE on its own line before exiting.",
    "",
    "Persist handoff context in `.pi/ralph-progress.md` when useful so the next iteration can continue without relying on chat memory.",
  ].join("\n");
}

function firstMarkdownHeading(text: string | undefined): string | undefined {
  const match = (text ?? "").match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || undefined;
}

function deriveHandoffTitle(job: RemoteAgentJob): string | undefined {
  return (
    job.handoff?.title?.trim() ||
    firstMarkdownHeading(job.handoff?.progress) ||
    firstMarkdownHeading(job.handoff?.todo) ||
    firstMarkdownHeading(job.handoff?.notes)
  );
}

function applyHandoffTitle(job: RemoteAgentJob): void {
  const title = deriveHandoffTitle(job);
  if (title) job.title = title;
}

function buildRalphIterationCommand(
  agent: RemoteAgentRecord | undefined,
  job: RemoteAgentJob,
  cwd: string,
  iteration: number,
): string[] {
  const prompt = buildRalphIterationPrompt(job, iteration);
  // Derive provider from the actual job command — provider belongs to the session, not the machine.
  const jobProvider = job.command?.[1]?.toLowerCase();
  const isClaudeJob = jobProvider === "claude";
  const isCodexJob = jobProvider === "codex";
  if (!isClaudeJob && !isCodexJob) {
    // Fallback: legacy agent.toolType for very old records without a command
    const toolType = agent?.toolType.toLowerCase() ?? "";
    if (toolType.includes("claude")) {
      return ["pi-agent", "claude", "--cwd", cwd, "--", prompt];
    }
  }
  if (isClaudeJob) {
    return ["pi-agent", "claude", "--cwd", cwd, "--", prompt];
  }
  return [
    "pi-agent",
    "codex",
    "--cwd",
    cwd,
    "--",
    ...codexModelArgs({
      model: job.model,
      reasoningEffort: job.reasoningEffort,
    }),
    prompt,
  ];
}

function maybeQueueRalphIteration(store: RemoteAgentStore, job: RemoteAgentJob): void {
  if (!job.ralphEnabled) return;
  if ((job.ralphMode ?? "iteration") !== "iteration") return;
  if (job.status !== "completed") return;
  if (containsRalphComplete(job.logTail)) return;
  if (containsUsageLimit(`${job.error ?? ""}\n${job.logTail ?? ""}`)) return;
  if (needsCodexRestart(`${job.error ?? ""}\n${job.logTail ?? ""}`)) return;

  const currentIteration = job.ralphIteration ?? 1;
  const maxIterations = job.ralphMaxIterations ?? DEFAULT_RALPH_MAX_ITERATIONS;
  if (currentIteration >= maxIterations) return;

  const existing = store.jobs.some(
    (entry) =>
      entry.parentJobId === job.jobId &&
      !entry.archivedAt &&
      (entry.status === "queued" || entry.status === "running" || entry.status === "completed"),
  );
  if (existing) return;

  const agent = store.agents.find((entry) => entry.agentId === job.agentId);
  const cwd = job.cwd ?? commandCwd(job.command) ?? agent?.worktree ?? agent?.repoRoot;
  if (!cwd) return;

  const now = new Date().toISOString();
  const nextIteration = currentIteration + 1;
  const nextJob: RemoteAgentJob = {
    jobId: `raj_${randomUUID()}`,
    agentId: job.agentId,
    type: "start_agent",
    title: `${ralphTaskSeed(job)} (Ralph iteration ${nextIteration})`,
    command: buildRalphIterationCommand(agent, job, cwd, nextIteration),
    cwd,
    env: {
      ...(job.env ?? {}),
      PI_RALPH_ENABLED: "1",
      PI_RALPH_MODE: "iteration",
      PI_RALPH_PARENT_JOB_ID: job.jobId,
      PI_RALPH_ITERATION: String(nextIteration),
      PI_AUTO_RESUME_USAGE_LIMIT: job.autoResumeUsageLimit ? "1" : "0",
      PI_AUTO_RESTART_CODEX: job.autoRestartCodex ? "1" : "0",
      PI_CODEX_MODEL: job.model ?? "",
      PI_CODEX_REASONING_EFFORT: job.reasoningEffort ?? "",
    },
    status: "queued",
    createdAt: now,
    updatedAt: now,
    parentJobId: job.jobId,
    ralphEnabled: true,
    ralphMode: "iteration",
    ralphIteration: nextIteration,
    ralphMaxIterations: maxIterations,
    autoResumeUsageLimit: job.autoResumeUsageLimit,
    autoRestartCodex: job.autoRestartCodex,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
  };

  job.ralphLastQueuedAt = now;
  store.jobs.unshift(nextJob);
  appendRemoteEvent(store, {
    type: "session.ralph_iteration_queued",
    agentId: nextJob.agentId,
    jobId: nextJob.jobId,
    createdAt: now,
    metadata: {
      parentJobId: job.jobId,
      iteration: nextIteration,
    },
  });
}

function maybeQueueCodexRestartResume(store: RemoteAgentStore, job: RemoteAgentJob): void {
  if (!job.autoRestartCodex) return;
  if (!needsCodexRestart(`${job.error ?? ""}\n${job.logTail ?? ""}`)) return;

  const attempts = job.autoRestartAttempts ?? 0;
  if (attempts >= MAX_AUTO_RESTART_ATTEMPTS) return;
  const existing = store.jobs.some(
    (entry) =>
      entry.parentJobId === job.jobId &&
      !entry.archivedAt &&
      (entry.status === "queued" || entry.status === "running"),
  );
  if (existing) return;

  const agent = store.agents.find((entry) => entry.agentId === job.agentId);
  const candidate = findResumeCandidate(agent, job);
  if (!candidate) return;

  const now = new Date().toISOString();
  const cwd = candidate.cwd ?? job.cwd ?? commandCwd(job.command) ?? agent?.worktree ?? agent?.repoRoot;
  if (!cwd) return;

  const nextJob: RemoteAgentJob = {
    jobId: `raj_${randomUUID()}`,
    agentId: job.agentId,
    type: "start_agent",
    title: `Restart Codex session: ${candidate.sessionId.slice(0, 8)}`,
    command: buildCodexResumeCommand(candidate, cwd, {
      model: job.model,
      reasoningEffort: job.reasoningEffort,
    }),
    cwd,
    env: {
      ...(job.env ?? {}),
      PI_RALPH_ENABLED: job.ralphEnabled ? "1" : "0",
      PI_RALPH_MODE: job.ralphEnabled ? "iteration" : "off",
      PI_AUTO_RESUME_USAGE_LIMIT: job.autoResumeUsageLimit ? "1" : "0",
      PI_AUTO_RESTART_CODEX: "1",
      PI_CODEX_SESSION_ID: candidate.sessionId,
      PI_AUTO_RESTART_PARENT_JOB_ID: job.jobId,
      PI_CODEX_MODEL: job.model ?? "",
      PI_CODEX_REASONING_EFFORT: job.reasoningEffort ?? "",
    },
    status: "queued",
    createdAt: now,
    updatedAt: now,
    parentJobId: job.jobId,
    ralphEnabled: job.ralphEnabled,
    ralphMode: job.ralphEnabled ? "iteration" : "off",
    ralphIteration: job.ralphIteration,
    ralphMaxIterations: job.ralphMaxIterations,
    autoResumeUsageLimit: job.autoResumeUsageLimit,
    autoRestartCodex: true,
    autoRestartAttempts: attempts + 1,
    autoRestartLastAt: now,
    codexSessionId: candidate.sessionId,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
  };

  job.restartRequiredAt = job.restartRequiredAt ?? now;
  job.autoRestartAttempts = attempts + 1;
  job.autoRestartLastAt = now;
  job.restartedAsJobId = nextJob.jobId;
  store.jobs.unshift(nextJob);
  appendRemoteEvent(store, {
    type: "session.restarted",
    agentId: nextJob.agentId,
    jobId: nextJob.jobId,
    createdAt: now,
    metadata: {
      parentJobId: job.jobId,
      codexSessionId: candidate.sessionId,
      automatic: true,
    },
  });
}

function parseUsageLimitRetryAt(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/try again at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?/i);
  if (!match) return undefined;

  const now = new Date();
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const retryAt = new Date(now);
  retryAt.setHours(hour, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt.toISOString();
}

function isReadyToLaunch(job: RemoteAgentJob): boolean {
  if (job.status !== "queued" || job.archivedAt) return false;
  if (!job.nextResumeAt) return true;
  return new Date(job.nextResumeAt).getTime() <= Date.now();
}

function maybeQueueUsageLimitResume(store: RemoteAgentStore, job: RemoteAgentJob): void {
  if (!job.autoResumeUsageLimit) return;
  if (!containsUsageLimit(`${job.error ?? ""}\n${job.logTail ?? ""}`)) return;
  if (job.command.length === 0) return;
  const attempts = job.autoResumeAttempts ?? 0;
  if (attempts >= MAX_AUTO_RESUME_ATTEMPTS) return;
  const existing = store.jobs.some(
    (entry) =>
      entry.parentJobId === job.jobId &&
      !entry.archivedAt &&
      (entry.status === "queued" || entry.status === "running"),
  );
  if (existing) return;

  const now = new Date().toISOString();
  const nextResumeAt =
    parseUsageLimitRetryAt(job.logTail) ??
    new Date(Date.now() + USAGE_LIMIT_RETRY_DELAY_MS).toISOString();
  const nextJob: RemoteAgentJob = {
    jobId: `raj_${randomUUID()}`,
    agentId: job.agentId,
    type: "start_agent",
    title: `${job.title} (auto resume ${attempts + 1})`,
    command: job.command,
    cwd: job.cwd,
    env: {
      ...(job.env ?? {}),
      PI_RALPH_ENABLED: job.ralphEnabled ? "1" : "0",
      PI_RALPH_MODE: job.ralphEnabled ? "iteration" : "off",
      PI_AUTO_RESUME_USAGE_LIMIT: "1",
      PI_AUTO_RESUME_PARENT_JOB_ID: job.jobId,
      PI_CODEX_MODEL: job.model ?? "",
      PI_CODEX_REASONING_EFFORT: job.reasoningEffort ?? "",
    },
    status: "queued",
    createdAt: now,
    updatedAt: now,
    parentJobId: job.jobId,
    ralphEnabled: job.ralphEnabled,
    ralphMode: job.ralphEnabled ? "iteration" : "off",
    ralphIteration: job.ralphIteration,
    ralphMaxIterations: job.ralphMaxIterations,
    autoResumeUsageLimit: true,
    autoRestartCodex: job.autoRestartCodex,
    autoResumeAttempts: attempts + 1,
    autoResumeLastAt: now,
    nextResumeAt,
    codexSessionId: job.codexSessionId,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
  };
  job.autoResumeAttempts = attempts + 1;
  job.autoResumeLastAt = now;
  job.nextResumeAt = nextResumeAt;
  store.jobs.unshift(nextJob);
  appendRemoteEvent(store, {
    type: "session.auto_resume_queued",
    agentId: nextJob.agentId,
    jobId: nextJob.jobId,
    createdAt: now,
    metadata: {
      parentJobId: job.jobId,
      nextResumeAt,
      attempt: attempts + 1,
    },
  });
}

async function normalizeStore(): Promise<RemoteAgentStore> {
  const store = await readStore();
  for (const request of store.requests) {
    const agent = store.agents.find((entry) => entry.agentId === request.agentId);
    if (!agent) continue;
    const previousStatus = request.status;
    const approved = applyAutoPolicy(agent, request);
    if (request.status === "approved" && request.eventType === "external_action") {
      queueApprovedExternalAction(store, request);
    }
    if (previousStatus !== request.status) {
      appendRemoteEvent(store, {
        type: "approval.decided",
        agentId: agent.agentId,
        jobId: request.parentJobId,
        requestId: request.requestId,
        createdAt: request.updatedAt,
        metadata: {
          decision: request.status,
          source: "policy",
          mode: agent.permissionMode,
        },
      });
    }
    if (approved) {
      const hasMoreOpen = store.requests.some(
        (entry) => entry.agentId === agent.agentId && entry.status === "open",
      );
      agent.status = hasMoreOpen ? "awaiting_approval" : "running";
      agent.lastSeenAt = request.updatedAt;
    }
  }
  await writeStore(store);
  return store;
}

export async function registerRemoteAgent(input: {
  agentId?: string;
  displayName: string;
  projectLabel: string;
  toolType: string;
  hostLabel: string;
  repoRoot?: string;
  branch?: string;
  worktree?: string;
  stateFile?: string;
  logFile?: string;
  status?: RemoteAgentStatus;
  connectionState?: RemoteAgentConnectionState;
  consecutiveFailures?: number;
  lastError?: string;
  nextRetryAt?: string;
  relay?: RemoteRelayState;
  sessionHistory?: RemoteAgentSessionHistoryItem[];
  authConnectors?: RemoteAuthConnectorSummary[];
}): Promise<RemoteAgentRecord> {
  const store = await readStore();
  const now = new Date().toISOString();
  const agentId = input.agentId?.trim() || `rag_${randomUUID()}`;
  const existing = store.agents.find((agent) => agent.agentId === agentId);

  const next: RemoteAgentRecord = {
    agentId,
    displayName: input.displayName.trim(),
    projectLabel: input.projectLabel.trim(),
    toolType: input.toolType.trim(),
    hostLabel: input.hostLabel.trim(),
    repoRoot: input.repoRoot?.trim(),
    branch: input.branch?.trim(),
    worktree: input.worktree?.trim(),
    stateFile: input.stateFile?.trim() || existing?.stateFile,
    logFile: input.logFile?.trim() || existing?.logFile,
    status: input.status ?? existing?.status ?? "running",
    permissionMode: existing?.permissionMode ?? "manual",
    timeoutSeconds: existing?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    connectionState: input.connectionState ?? existing?.connectionState ?? "connected",
    consecutiveFailures: input.consecutiveFailures ?? existing?.consecutiveFailures ?? 0,
    lastError: input.lastError?.trim() || existing?.lastError,
    nextRetryAt: input.nextRetryAt?.trim() || existing?.nextRetryAt,
    relay: input.relay ?? existing?.relay,
    sessionHistory: normalizeSessionHistory(input.sessionHistory) ?? existing?.sessionHistory,
    authConnectors: normalizeAuthConnectors(input.authConnectors) ?? existing?.authConnectors,
    lastSeenAt: now,
    createdAt: existing?.createdAt ?? now,
  };

  store.agents = [...store.agents.filter((agent) => agent.agentId !== agentId), next];
  appendRemoteEvent(store, {
    type: existing ? "machine.connected" : "machine.registered",
    agentId,
    createdAt: now,
    metadata: {
      displayName: next.displayName,
      hostLabel: next.hostLabel,
      toolType: next.toolType,
    },
  });
  await writeStore(store);
  return next;
}

export async function heartbeatRemoteAgent(input: {
  agentId: string;
  status?: RemoteAgentStatus;
  branch?: string;
  worktree?: string;
  repoRoot?: string;
  stateFile?: string;
  logFile?: string;
  connectionState?: RemoteAgentConnectionState;
  consecutiveFailures?: number;
  lastError?: string;
  nextRetryAt?: string;
  relay?: RemoteRelayState;
  sessionHistory?: RemoteAgentSessionHistoryItem[];
  authConnectors?: RemoteAuthConnectorSummary[];
}): Promise<RemoteAgentRecord> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === input.agentId);
  if (!agent) {
    throw new Error(`Unknown remote agent: ${input.agentId}`);
  }
  const previousConnectionState = deriveConnectionState(agent);
  agent.status = input.status ?? agent.status;
  agent.branch = input.branch?.trim() || agent.branch;
  agent.worktree = input.worktree?.trim() || agent.worktree;
  agent.repoRoot = input.repoRoot?.trim() || agent.repoRoot;
  agent.stateFile = input.stateFile?.trim() || agent.stateFile;
  agent.logFile = input.logFile?.trim() || agent.logFile;
  // Preserve user-set "disabled" — a heartbeat from the live agent cannot re-enable it.
  if (agent.connectionState !== "disabled") {
    agent.connectionState = input.connectionState ?? agent.connectionState;
  }
  agent.consecutiveFailures =
    typeof input.consecutiveFailures === "number" ? Math.max(0, Math.floor(input.consecutiveFailures)) : agent.consecutiveFailures;
  agent.lastError = input.lastError?.trim() || undefined;
  agent.nextRetryAt = input.nextRetryAt?.trim() || undefined;
  agent.relay = input.relay ?? agent.relay;
  agent.sessionHistory = normalizeSessionHistory(input.sessionHistory) ?? agent.sessionHistory;
  agent.authConnectors = normalizeAuthConnectors(input.authConnectors) ?? agent.authConnectors;
  agent.lastSeenAt = new Date().toISOString();
  const nextConnectionState = deriveConnectionState(agent);
  if (previousConnectionState !== nextConnectionState) {
    appendRemoteEvent(store, {
      type: nextConnectionState === "connected" ? "machine.connected" : "machine.disconnected",
      agentId: agent.agentId,
      createdAt: agent.lastSeenAt,
      severity: nextConnectionState === "connected" ? "info" : "warning",
      metadata: {
        from: previousConnectionState,
        to: nextConnectionState,
      },
    });
  }
  await writeStore(store);
  return agent;
}

export async function updateRemoteAgentDetails(input: {
  agentId: string;
  displayName?: string;
  projectLabel?: string;
}): Promise<RemoteAgentRecord> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === input.agentId);
  if (!agent) {
    throw new Error(`Unknown remote agent: ${input.agentId}`);
  }

  const displayName = input.displayName?.trim();
  const projectLabel = input.projectLabel?.trim();
  if (displayName) agent.displayName = displayName;
  if (projectLabel) agent.projectLabel = projectLabel;
  appendRemoteEvent(store, {
    type: "machine.updated",
    agentId: agent.agentId,
    metadata: {
      displayName: agent.displayName,
      projectLabel: agent.projectLabel,
    },
  });

  await writeStore(store);
  return agent;
}

/** Mark an agent as user-disabled. PI stops dispatching jobs; the agent is kept in the store. */
export async function disableRemoteAgent(agentId: string): Promise<RemoteAgentRecord> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === agentId);
  if (!agent) throw new Error(`Unknown remote agent: ${agentId}`);
  agent.connectionState = "disabled";
  agent.status = "paused";
  appendRemoteEvent(store, { type: "machine.updated", agentId, metadata: { connectionState: "disabled" } });
  await writeStore(store);
  return agent;
}

/**
 * Permanently remove an agent and its associated enrollments and open requests.
 * Jobs are kept for audit history.
 * Throws if the agent has active (running/queued) jobs.
 */
export async function forgetRemoteAgent(agentId: string): Promise<void> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === agentId);
  if (!agent) throw new Error(`Unknown remote agent: ${agentId}`);

  const activeJobs = store.jobs.filter(
    (job) => job.agentId === agentId && (job.status === "running" || job.status === "queued") && !job.archivedAt,
  );
  if (activeJobs.length > 0) {
    throw new Error(
      `Cannot forget machine with ${activeJobs.length} active job(s). Stop or archive them first.`,
    );
  }

  store.agents = store.agents.filter((entry) => entry.agentId !== agentId);
  store.enrollments = store.enrollments.filter((entry) => {
    const consumed = entry.consumedAt;
    // Remove only unconsumed (pending) enrollments for this agent's display name + tool type combo.
    // Consumed enrollments don't carry agentId, so we match by display name to avoid over-deleting.
    if (consumed) return true;
    return entry.displayName !== agent.displayName || entry.toolType !== agent.toolType;
  });
  store.requests = store.requests.filter(
    (entry) => entry.agentId !== agentId || entry.status !== "open",
  );
  appendRemoteEvent(store, { type: "machine.updated", agentId, metadata: { forgotten: true } });
  await writeStore(store);
}

/**
 * Create a fresh enrollment for an existing (or forgotten) agent identity so it can re-pair.
 * Uses PI_PUBLIC_URL for the server address shown in the pair command.
 */
export async function createReconnectEnrollment(agentId: string): Promise<{
  enrollment: RemoteEnrollmentSummary;
  pairCommand: string;
  advancedCommand: string;
  relayUrl: string;
}> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === agentId);
  if (!agent) throw new Error(`Unknown remote agent: ${agentId}`);

  const enrollment = await createRemoteEnrollment({
    displayName: agent.displayName,
    projectLabel: agent.projectLabel,
    toolType: agent.toolType,
    expiresInMinutes: 60,
  });

  const serverOrigin = (process.env.PI_PUBLIC_URL ?? "").trim().replace(/\/$/, "") || "http://localhost:3000";
  // Derive the terminal relay WebSocket URL from the public server origin.
  // http://host:port → ws://host:14801/pi-agent-relay (local dev)
  // https://host    → wss://host/pi-agent-relay (production)
  let relayUrl: string;
  if (serverOrigin.startsWith("https://")) {
    const host = serverOrigin.slice("https://".length).split("/")[0];
    relayUrl = `wss://${host}/pi-agent-relay`;
  } else {
    const host = serverOrigin.replace(/^https?:\/\//, "").split(":")[0];
    const directPort = process.env.DIRECT_TERMINAL_PORT ?? "14801";
    relayUrl = `ws://${host}:${directPort}/pi-agent-relay`;
  }

  const pairCommand = `pi-agent pair --server ${serverOrigin} --code ${enrollment.code} --start`;
  const advancedCommand = `PI_TERMINAL_RELAY_URL=${relayUrl} \\\n  pi-agent pair --server ${serverOrigin} --code ${enrollment.code} --start`;
  return { enrollment, pairCommand, advancedCommand, relayUrl };
}

function deriveConnectionState(agent: RemoteAgentRecord): RemoteAgentConnectionState {
  // Preserve user-set disabled state — don't let heartbeat age override it.
  if (agent.connectionState === "disabled") return "disabled";
  const ageMs = Date.now() - new Date(agent.lastSeenAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 30_000) return agent.connectionState ?? "connected";
  if (ageMs < 120_000) return "stale";
  return "disconnected";
}

function normalizeRelayPublicUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let normalized = raw.trim().replace(/\/$/, "");
  if (!normalized) return undefined;
  if (normalized.startsWith("http://")) {
    normalized = "ws://" + normalized.slice("http://".length);
  } else if (normalized.startsWith("https://")) {
    normalized = "wss://" + normalized.slice("https://".length);
  }
  if (!normalized.endsWith("/ws")) {
    normalized = `${normalized}/ws`;
  }
  return normalized;
}

function relayDaemonToken(): string | undefined {
  const explicit = process.env.PI_RELAY_DAEMON_TOKEN?.trim();
  if (explicit) return explicit;

  const source = process.env.PI_RELAY_TOKENS?.trim();
  if (!source) return undefined;

  for (const entry of source.split(",")) {
    const [token, kind] = entry.trim().split(":");
    if (token && kind === "daemon") {
      return token;
    }
  }

  return undefined;
}

function activeEnrollments(store: RemoteAgentStore): RemoteEnrollmentRecord[] {
  const now = Date.now();
  return store.enrollments.filter((entry) => {
    if (entry.consumedAt) return false;
    if (entry.revokedAt) return false;
    return new Date(entry.expiresAt).getTime() > now;
  });
}

export async function createRemoteEnrollment(input: {
  displayName: string;
  projectLabel: string;
  toolType: string;
  expiresInMinutes?: number;
}): Promise<RemoteEnrollmentSummary> {
  const store = await readStore();
  const now = new Date();
  const expiresInMinutes = Math.max(5, Math.min(24 * 60, Math.floor(input.expiresInMinutes ?? 60)));
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60_000).toISOString();
  const code = randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();

  const enrollment: RemoteEnrollmentRecord = {
    enrollmentId: `ren_${randomUUID()}`,
    code,
    displayName: input.displayName.trim(),
    projectLabel: input.projectLabel.trim(),
    toolType: input.toolType.trim(),
    createdAt,
    expiresAt,
    relayUrl: normalizeRelayPublicUrl(
      process.env.PI_RELAY_PUBLIC_WS_URL ??
        process.env.PI_RELAY_URL ??
        process.env.PI_RELAY_BASE_URL,
    ),
    relayToken: relayDaemonToken(),
  };

  store.enrollments = [enrollment, ...activeEnrollments(store)];
  await writeStore(store);
  return enrollment;
}

export async function consumeRemoteEnrollment(input: {
  code: string;
}): Promise<{
  enrollment: RemoteEnrollmentSummary;
  config: {
    displayName: string;
    projectLabel: string;
    toolType: string;
    relayUrl?: string;
    relayToken?: string;
  };
}> {
  const store = await readStore();
  const code = input.code.trim().toUpperCase();
  const enrollment = store.enrollments.find((entry) => entry.code === code);
  if (!enrollment) {
    throw new Error("Unknown enrollment code");
  }
  if (enrollment.revokedAt) {
    throw new Error("Enrollment code has been revoked");
  }
  if (enrollment.consumedAt) {
    throw new Error("Enrollment code has already been used");
  }
  if (new Date(enrollment.expiresAt).getTime() <= Date.now()) {
    throw new Error("Enrollment code has expired");
  }

  enrollment.consumedAt = new Date().toISOString();
  await writeStore(store);

  return {
    enrollment,
    config: {
      displayName: enrollment.displayName,
      projectLabel: enrollment.projectLabel,
      toolType: enrollment.toolType,
      relayUrl: enrollment.relayUrl,
      relayToken: enrollment.relayToken,
    },
  };
}

export async function revokeRemoteEnrollment(input: {
  enrollmentId: string;
}): Promise<RemoteEnrollmentSummary> {
  const store = await readStore();
  const enrollment = store.enrollments.find((entry) => entry.enrollmentId === input.enrollmentId);
  if (!enrollment) {
    throw new Error("Unknown enrollment code");
  }
  if (enrollment.consumedAt) {
    throw new Error("Enrollment code has already been used");
  }
  if (!enrollment.revokedAt) {
    enrollment.revokedAt = new Date().toISOString();
    await writeStore(store);
  }
  return enrollment;
}

export async function getRemoteEnrollmentForBootstrap(input: {
  enrollmentId: string;
}): Promise<RemoteEnrollmentSummary> {
  const store = await readStore();
  const enrollment = store.enrollments.find((entry) => entry.enrollmentId === input.enrollmentId);
  if (!enrollment) {
    throw new Error("Unknown enrollment code");
  }
  if (enrollment.revokedAt) {
    throw new Error("Enrollment code has been revoked");
  }
  if (enrollment.consumedAt) {
    throw new Error("Enrollment code has already been used");
  }
  if (new Date(enrollment.expiresAt).getTime() <= Date.now()) {
    throw new Error("Enrollment code has expired");
  }
  return serializeEnrollment(enrollment);
}

export async function createRemoteApprovalRequest(input: {
  agentId: string;
  parentJobId?: string;
  title: string;
  message: string;
  riskLevel?: PIApprovalRiskLevel;
  command?: string;
  actionKind?: PIExternalActionKind;
  suggestedCommand?: string;
  helperPrompt?: string;
  eventType?: PIApprovalEventType;
  primaryAction?: PIApprovalPrimaryAction;
}): Promise<RemoteApprovalRequestRecord> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === input.agentId);
  if (!agent) {
    throw new Error(`Unknown remote agent: ${input.agentId}`);
  }

  const now = new Date().toISOString();
  const request: RemoteApprovalRequestRecord = {
    requestId: `rar_${randomUUID()}`,
    agentId: input.agentId,
    parentJobId: input.parentJobId?.trim() || undefined,
    title: input.title.trim(),
    message: input.message.trim(),
    riskLevel: input.riskLevel ?? "medium",
    command: input.command?.trim() || null,
    actionKind: input.actionKind,
    suggestedCommand: input.suggestedCommand?.trim() || null,
    helperPrompt: input.helperPrompt?.trim() || null,
    eventType: input.eventType ?? (input.command?.trim() ? "command" : "generic"),
    primaryAction: input.primaryAction ?? (input.command?.trim() ? "approve" : "reply"),
    status: "open",
    createdAt: now,
    updatedAt: now,
  };

  store.requests.unshift(request);
  agent.status = "awaiting_approval";
  agent.lastSeenAt = now;
  appendRemoteEvent(store, {
    type: "approval.requested",
    agentId: agent.agentId,
    jobId: request.parentJobId,
    requestId: request.requestId,
    createdAt: now,
    severity: request.riskLevel === "high" ? "warning" : "attention",
    metadata: {
      riskLevel: request.riskLevel,
      eventType: request.eventType ?? "generic",
      primaryAction: request.primaryAction ?? "reply",
      autoPolicy: agent.permissionMode,
    },
  });
  applyAutoPolicy(agent, request);
  if (request.status === "approved" && request.eventType === "external_action") {
    queueApprovedExternalAction(store, request);
  }
  if (request.status === "approved") {
    agent.status = "running";
    agent.lastSeenAt = request.updatedAt;
    appendRemoteEvent(store, {
      type: "approval.decided",
      agentId: agent.agentId,
      jobId: request.parentJobId,
      requestId: request.requestId,
      createdAt: request.updatedAt,
      metadata: {
        decision: "approved",
        source: "policy",
        mode: agent.permissionMode,
      },
    });
  }
  await writeStore(store);
  return request;
}

export async function setRemoteAgentPolicy(input: {
  agentId: string;
  mode?: PIApprovalPermissionMode;
  cycle?: boolean;
  timeoutSeconds?: number;
}): Promise<RemoteAgentRecord> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === input.agentId);
  if (!agent) {
    throw new Error(`Unknown remote agent: ${input.agentId}`);
  }
  agent.permissionMode = input.cycle
    ? cycleMode(agent.permissionMode)
    : (input.mode ?? agent.permissionMode);
  agent.timeoutSeconds =
    typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0
      ? Math.floor(input.timeoutSeconds)
      : agent.timeoutSeconds;
  agent.lastSeenAt = new Date().toISOString();
  appendRemoteEvent(store, {
    type: "policy.updated",
    agentId: agent.agentId,
    createdAt: agent.lastSeenAt,
    metadata: {
      permissionMode: agent.permissionMode,
      timeoutSeconds: agent.timeoutSeconds,
    },
  });

  for (const request of store.requests.filter((entry) => entry.agentId === agent.agentId)) {
    const previousStatus = request.status;
    applyAutoPolicy(agent, request);
    if (request.status === "approved" && request.eventType === "external_action") {
      queueApprovedExternalAction(store, request);
    }
    if (previousStatus !== request.status) {
      appendRemoteEvent(store, {
        type: "approval.decided",
        agentId: agent.agentId,
        jobId: request.parentJobId,
        requestId: request.requestId,
        createdAt: request.updatedAt,
        metadata: {
          decision: request.status,
          source: "policy",
          mode: agent.permissionMode,
        },
      });
    }
  }

  await writeStore(store);
  return agent;
}

export async function respondToRemoteApproval(input: {
  requestId: string;
  action: "approve" | "reject";
  response?: string;
}): Promise<RemoteApprovalRequestRecord> {
  const store = await readStore();
  const request = store.requests.find((entry) => entry.requestId === input.requestId);
  if (!request) {
    throw new Error(`Unknown remote approval request: ${input.requestId}`);
  }
  request.status = input.action === "approve" ? "approved" : "rejected";
  request.response = input.response?.trim() || undefined;
  request.updatedAt = new Date().toISOString();
  appendRemoteEvent(store, {
    type: "approval.decided",
    agentId: request.agentId,
    jobId: request.parentJobId,
    requestId: request.requestId,
    createdAt: request.updatedAt,
    severity: input.action === "reject" ? "warning" : "info",
    metadata: {
      decision: request.status,
      source: "user",
    },
  });

  const agent = store.agents.find((entry) => entry.agentId === request.agentId);
  if (agent) {
    const hasMoreOpen = store.requests.some(
      (entry) => entry.agentId === agent.agentId && entry.status === "open",
    );
    agent.status = hasMoreOpen ? "awaiting_approval" : "running";
    agent.lastSeenAt = request.updatedAt;
  }

  if (input.action === "approve" && request.eventType === "external_action") {
    queueApprovedExternalAction(store, request);
  }

  await writeStore(store);
  return request;
}

function queueApprovedExternalAction(
  store: RemoteAgentStore,
  request: RemoteApprovalRequestRecord,
): RemoteAgentJob | undefined {
  const agent = store.agents.find((entry) => entry.agentId === request.agentId);
  if (!agent) return undefined;

  const alreadyQueued = store.jobs.find(
    (job) => job.env?.PI_EXTERNAL_ACTION_REQUEST_ID === request.requestId,
  );
  if (alreadyQueued) {
    if (!alreadyQueued.parentJobId && request.parentJobId) {
      alreadyQueued.parentJobId = request.parentJobId;
      alreadyQueued.updatedAt = new Date().toISOString();
    }
    request.createdJobId = alreadyQueued.jobId;
    request.updatedAt = new Date().toISOString();
    return alreadyQueued;
  }

  const now = new Date().toISOString();
  const cwd = agent.worktree ?? agent.repoRoot ?? undefined;
  const command = buildExternalActionCommand(request);
  if (!command) return undefined;

  const job: RemoteAgentJob = {
    jobId: `raj_${randomUUID()}`,
    agentId: request.agentId,
    type: "start_agent",
    title: externalActionTitle(request),
    command,
    cwd: cwd ?? null,
    env: {
      PI_EXTERNAL_ACTION_REQUEST_ID: request.requestId,
      PI_EXTERNAL_ACTION_KIND: request.actionKind ?? "other",
      PI_REMOTE_INTERACTIVE: "1",
    },
    status: "queued",
    createdAt: now,
    updatedAt: now,
    parentJobId: request.parentJobId,
    ralphEnabled: false,
    ralphMode: "off",
    autoResumeUsageLimit: false,
    autoRestartCodex: false,
  };

  request.createdJobId = job.jobId;
  request.updatedAt = now;
  store.jobs.unshift(job);
  agent.lastSeenAt = now;
  appendRemoteEvent(store, {
    type: "session.created",
    agentId: agent.agentId,
    jobId: job.jobId,
    requestId: request.requestId,
    createdAt: now,
    metadata: {
      source: "external_action",
      actionKind: request.actionKind ?? "other",
    },
  });
  return job;
}

function externalActionTitle(request: RemoteApprovalRequestRecord): string {
  if (request.actionKind === "codex_update") return "Update Codex CLI";
  return request.title || "Run external action";
}

function buildExternalActionCommand(request: RemoteApprovalRequestRecord): string[] | undefined {
  if (request.actionKind === "codex_update") {
    const installCommand = request.suggestedCommand?.trim() || "npm install -g @openai/codex";
    return [
      "bash",
      "-lc",
      [
        "set -e",
        `echo "Updating Codex CLI..."`,
        installCommand,
        `echo "Codex version after update:"`,
        "codex --version",
      ].join("\n"),
    ];
  }

  const suggestedCommand = request.suggestedCommand?.trim();
  if (!suggestedCommand) return undefined;
  return ["bash", "-lc", suggestedCommand];
}

export async function createRemoteAgentJob(input: {
  agentId: string;
  title?: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  ralphEnabled?: boolean;
  autoResumeUsageLimit?: boolean;
  autoRestartCodex?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  const agent = store.agents.find((entry) => entry.agentId === input.agentId);
  if (!agent) {
    throw new Error(`Unknown remote agent: ${input.agentId}`);
  }
  const command = input.command.map((part) => String(part)).filter(Boolean);
  if (command.length === 0) {
    throw new Error("Remote agent job requires a non-empty command");
  }

  const now = new Date().toISOString();
  const job: RemoteAgentJob = {
    jobId: `raj_${randomUUID()}`,
    agentId: input.agentId,
    type: "start_agent",
    title: input.title?.trim() || `Start ${command[0]}`,
    command,
    cwd: input.cwd?.trim() || null,
    env: input.env ?? {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
    ralphEnabled: input.ralphEnabled ?? false,
    ralphMode: input.ralphEnabled ? "iteration" : "off",
    ralphIteration: input.ralphEnabled ? 1 : undefined,
    ralphMaxIterations: input.ralphEnabled ? DEFAULT_RALPH_MAX_ITERATIONS : undefined,
    autoResumeUsageLimit: input.autoResumeUsageLimit ?? false,
    autoRestartCodex: input.autoRestartCodex ?? false,
    model: input.model?.trim() || undefined,
    reasoningEffort: input.reasoningEffort?.trim() || undefined,
    codexSessionId: input.env?.PI_CODEX_SESSION_ID,
  };
  store.jobs.unshift(job);
  agent.lastSeenAt = now;
  appendRemoteEvent(store, {
    type: "session.created",
    agentId: agent.agentId,
    jobId: job.jobId,
    createdAt: now,
    metadata: {
      title: job.title,
      provider: command[0],
      cwd: job.cwd ?? null,
      ralphEnabled: Boolean(job.ralphEnabled),
    },
  });
  await writeStore(store);
  return job;
}

export async function updateRemoteAgentJobSettings(input: {
  jobId: string;
  agentId?: string;
  ralphEnabled?: boolean;
  autoResumeUsageLimit?: boolean;
  autoRestartCodex?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  const job = store.jobs.find((entry) => entry.jobId === input.jobId);
  if (!job) {
    throw new Error(`Unknown remote agent job: ${input.jobId}`);
  }
  if (input.agentId && job.agentId !== input.agentId) {
    throw new Error(`Remote job ${input.jobId} does not belong to agent ${input.agentId}`);
  }
  if (typeof input.ralphEnabled === "boolean") {
    job.ralphEnabled = input.ralphEnabled;
    job.ralphMode = input.ralphEnabled ? "iteration" : "off";
    job.ralphIteration = input.ralphEnabled ? (job.ralphIteration ?? 1) : undefined;
    job.ralphMaxIterations = input.ralphEnabled
      ? (job.ralphMaxIterations ?? DEFAULT_RALPH_MAX_ITERATIONS)
      : undefined;
    job.env = {
      ...(job.env ?? {}),
      PI_RALPH_ENABLED: input.ralphEnabled ? "1" : "0",
      PI_RALPH_MODE: input.ralphEnabled ? "iteration" : "off",
      PI_RALPH_ITERATION: input.ralphEnabled ? String(job.ralphIteration ?? 1) : "",
    };
    if (!input.ralphEnabled) {
      job.pendingInputs = (job.pendingInputs ?? []).filter(
        (entry) => !entry.text.startsWith("Ralph loop:"),
      );
      job.ralphLastIdleSignature = undefined;
    }
  }
  if (typeof input.autoResumeUsageLimit === "boolean") {
    job.autoResumeUsageLimit = input.autoResumeUsageLimit;
    job.env = {
      ...(job.env ?? {}),
      PI_AUTO_RESUME_USAGE_LIMIT: input.autoResumeUsageLimit ? "1" : "0",
    };
  }
  if (typeof input.autoRestartCodex === "boolean") {
    job.autoRestartCodex = input.autoRestartCodex;
    job.env = {
      ...(job.env ?? {}),
      PI_AUTO_RESTART_CODEX: input.autoRestartCodex ? "1" : "0",
    };
  }
  if (input.model !== undefined) {
    const model = input.model?.trim() || undefined;
    job.model = model;
    job.env = {
      ...(job.env ?? {}),
      PI_CODEX_MODEL: model ?? "",
    };
  }
  if (input.reasoningEffort !== undefined) {
    const reasoningEffort = input.reasoningEffort?.trim() || undefined;
    job.reasoningEffort = reasoningEffort;
    job.env = {
      ...(job.env ?? {}),
      PI_CODEX_REASONING_EFFORT: reasoningEffort ?? "",
    };
  }
  job.updatedAt = new Date().toISOString();
  appendRemoteEvent(store, {
    type: "policy.updated",
    agentId: job.agentId,
    jobId: job.jobId,
    createdAt: job.updatedAt,
    metadata: {
      ralphEnabled: Boolean(job.ralphEnabled),
      autoResumeUsageLimit: Boolean(job.autoResumeUsageLimit),
      autoRestartCodex: Boolean(job.autoRestartCodex),
      model: job.model ?? null,
      reasoningEffort: job.reasoningEffort ?? null,
    },
  });
  maybeQueueRalphIteration(store, job);
  maybeQueueUsageLimitResume(store, job);
  maybeQueueCodexRestartResume(store, job);
  await writeStore(store);
  return job;
}

export async function restartRemoteCodexJob(input: {
  jobId: string;
  agentId?: string;
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  const job = store.jobs.find((entry) => entry.jobId === input.jobId);
  if (!job) {
    throw new Error(`Unknown remote agent job: ${input.jobId}`);
  }
  if (input.agentId && job.agentId !== input.agentId) {
    throw new Error(`Remote job ${input.jobId} does not belong to agent ${input.agentId}`);
  }
  const agent = store.agents.find((entry) => entry.agentId === job.agentId);
  if (!agent) {
    throw new Error(`Unknown remote agent: ${job.agentId}`);
  }
  const candidate = findResumeCandidate(agent, job);
  if (!candidate) {
    throw new Error("No Codex session history is available to resume");
  }
  const cwd = candidate.cwd ?? job.cwd ?? commandCwd(job.command) ?? agent.worktree ?? agent.repoRoot;
  if (!cwd) {
    throw new Error("No working directory is available for the resumed Codex session");
  }

  const now = new Date().toISOString();
  const nextJob: RemoteAgentJob = {
    jobId: `raj_${randomUUID()}`,
    agentId: job.agentId,
    type: "start_agent",
    title: `Restart Codex session: ${candidate.sessionId.slice(0, 8)}`,
    command: buildCodexResumeCommand(candidate, cwd, {
      model: job.model,
      reasoningEffort: job.reasoningEffort,
    }),
    cwd,
    env: {
      ...(job.env ?? {}),
      PI_RALPH_ENABLED: job.ralphEnabled ? "1" : "0",
      PI_RALPH_MODE: job.ralphEnabled ? "iteration" : "off",
      PI_AUTO_RESUME_USAGE_LIMIT: job.autoResumeUsageLimit ? "1" : "0",
      PI_AUTO_RESTART_CODEX: job.autoRestartCodex ? "1" : "0",
      PI_CODEX_SESSION_ID: candidate.sessionId,
      PI_RESTART_PARENT_JOB_ID: job.jobId,
      PI_CODEX_MODEL: job.model ?? "",
      PI_CODEX_REASONING_EFFORT: job.reasoningEffort ?? "",
    },
    status: "queued",
    createdAt: now,
    updatedAt: now,
    parentJobId: job.jobId,
    ralphEnabled: job.ralphEnabled,
    ralphMode: job.ralphEnabled ? "iteration" : "off",
    ralphIteration: job.ralphIteration,
    ralphMaxIterations: job.ralphMaxIterations,
    autoResumeUsageLimit: job.autoResumeUsageLimit,
    autoRestartCodex: job.autoRestartCodex,
    codexSessionId: candidate.sessionId,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
  };

  job.restartRequiredAt = job.restartRequiredAt ?? now;
  job.restartedAsJobId = nextJob.jobId;
  job.updatedAt = now;
  store.jobs.unshift(nextJob);
  appendRemoteEvent(store, {
    type: "session.restarted",
    agentId: nextJob.agentId,
    jobId: nextJob.jobId,
    createdAt: now,
    metadata: {
      parentJobId: job.jobId,
      codexSessionId: candidate.sessionId,
      automatic: false,
    },
  });
  await writeStore(store);
  return nextJob;
}

function buildHandoffContinuationPrompt(job: RemoteAgentJob, sourceAgent: RemoteAgentRecord | undefined): string {
  const progress = job.handoff?.progress?.trim() || "No PROGRESS.md content was reported.";
  const todo = job.handoff?.todo?.trim() || "No TODO.md content was reported.";
  const notes = job.handoff?.notes?.trim() || "No NOTES.md content was reported.";
  const recentOutput = (job.logTail ?? "").trim().slice(-8_000) || "No recent terminal output was reported.";
  return [
    "Continue this PI coding session from a cross-machine handoff.",
    "",
    "You are not resuming the original terminal process. Treat this as a clean continuation on this machine.",
    "Use the handoff files as the durable source of truth, then inspect the workspace before editing.",
    "",
    "Source session:",
    `- Title: ${deriveHandoffTitle(job) || job.title}`,
    `- Job: ${job.jobId}`,
    `- Source machine: ${sourceAgent ? `${sourceAgent.displayName} / ${sourceAgent.hostLabel}` : job.agentId}`,
    `- Previous CWD: ${job.cwd ?? "unknown"}`,
    "",
    "Rules:",
    "- First read the local workspace state and confirm what exists on this machine.",
    "- Continue from the next actionable item in TODO.md.",
    "- If the local machine is missing files, credentials, remotes, or dependencies, ask PI through the external-action hook instead of guessing.",
    "- Keep PROGRESS.md, TODO.md, and NOTES.md updated through the PI_*_FILE environment variables.",
    "- When blocked or complete, update the handoff files before stopping.",
    "",
    "PROGRESS.md:",
    progress,
    "",
    "TODO.md:",
    todo,
    "",
    "NOTES.md:",
    notes,
    "",
    "Recent terminal output:",
    "```",
    recentOutput,
    "```",
  ].join("\n");
}

export async function continueRemoteAgentJobOnMachine(input: {
  jobId: string;
  sourceAgentId?: string;
  targetAgentId: string;
  cwd?: string;
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  const sourceJob = store.jobs.find((entry) => entry.jobId === input.jobId);
  if (!sourceJob) {
    throw new Error(`Unknown remote agent job: ${input.jobId}`);
  }
  if (input.sourceAgentId && sourceJob.agentId !== input.sourceAgentId) {
    throw new Error(`Remote job ${input.jobId} does not belong to agent ${input.sourceAgentId}`);
  }
  const targetAgent = store.agents.find((entry) => entry.agentId === input.targetAgentId);
  if (!targetAgent) {
    throw new Error(`Unknown target machine: ${input.targetAgentId}`);
  }
  const sourceAgent = store.agents.find((entry) => entry.agentId === sourceJob.agentId);
  const cwd =
    input.cwd?.trim() ||
    targetAgent.worktree ||
    targetAgent.repoRoot ||
    sourceJob.cwd ||
    commandCwd(sourceJob.command);
  if (!cwd) {
    throw new Error("No workspace folder is available for the continuation session");
  }

  const prompt = buildHandoffContinuationPrompt(sourceJob, sourceAgent);
  const provider = targetAgent.toolType.toLowerCase().includes("claude") ? "claude" : "codex";
  const command =
    provider === "claude"
      ? ["pi-agent", "claude", "--cwd", cwd, "--", prompt]
      : [
          "pi-agent",
          "codex",
          "--cwd",
          cwd,
          "--",
          ...codexModelArgs({
            model: sourceJob.model,
            reasoningEffort: sourceJob.reasoningEffort,
          }),
          prompt,
        ];
  const now = new Date().toISOString();
  const title = `Continue: ${deriveHandoffTitle(sourceJob) || sourceJob.title}`;
  const nextJob: RemoteAgentJob = {
    jobId: `raj_${randomUUID()}`,
    agentId: targetAgent.agentId,
    type: "start_agent",
    title,
    command,
    cwd,
    env: {
      ...(sourceJob.env ?? {}),
      PI_SESSION_TITLE: title,
      PI_SESSION_SOURCE: "handoff-continuation",
      PI_HANDOFF_PARENT_JOB_ID: sourceJob.jobId,
      PI_HANDOFF_SOURCE_AGENT_ID: sourceJob.agentId,
      PI_RALPH_ENABLED: sourceJob.ralphEnabled ? "1" : "0",
      PI_RALPH_MODE: sourceJob.ralphEnabled ? "iteration" : "off",
      PI_AUTO_RESUME_USAGE_LIMIT: sourceJob.autoResumeUsageLimit ? "1" : "0",
      PI_AUTO_RESTART_CODEX: sourceJob.autoRestartCodex ? "1" : "0",
      PI_CODEX_MODEL: sourceJob.model ?? "",
      PI_CODEX_REASONING_EFFORT: sourceJob.reasoningEffort ?? "",
    },
    status: "queued",
    createdAt: now,
    updatedAt: now,
    parentJobId: sourceJob.jobId,
    ralphEnabled: sourceJob.ralphEnabled,
    ralphMode: sourceJob.ralphEnabled ? "iteration" : "off",
    ralphIteration: sourceJob.ralphIteration,
    ralphMaxIterations: sourceJob.ralphMaxIterations,
    autoResumeUsageLimit: sourceJob.autoResumeUsageLimit,
    autoRestartCodex: sourceJob.autoRestartCodex,
    model: sourceJob.model,
    reasoningEffort: sourceJob.reasoningEffort,
    handoff: sourceJob.handoff
      ? {
          ...sourceJob.handoff,
          updatedAt: now,
        }
      : undefined,
    artifactsDir: sourceJob.artifactsDir,
  };

  sourceJob.updatedAt = now;
  sourceJob.continuedAsJobId = nextJob.jobId;
  store.jobs.unshift(nextJob);
  targetAgent.lastSeenAt = now;
  appendRemoteEvent(store, {
    type: "session.continued",
    agentId: targetAgent.agentId,
    jobId: nextJob.jobId,
    createdAt: now,
    metadata: {
      sourceJobId: sourceJob.jobId,
      sourceAgentId: sourceJob.agentId,
      targetAgentId: targetAgent.agentId,
    },
  });
  await writeStore(store);
  return nextJob;
}

export async function archiveRemoteAgentJob(input: {
  jobId: string;
  agentId?: string;
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  const job = store.jobs.find((entry) => entry.jobId === input.jobId);
  if (!job) {
    throw new Error(`Unknown remote agent job: ${input.jobId}`);
  }
  if (input.agentId && job.agentId !== input.agentId) {
    throw new Error(`Remote job ${input.jobId} does not belong to agent ${input.agentId}`);
  }
  job.archivedAt = new Date().toISOString();
  job.updatedAt = job.archivedAt;
  appendRemoteEvent(store, {
    type: "session.archived",
    agentId: job.agentId,
    jobId: job.jobId,
    createdAt: job.archivedAt,
  });
  await writeStore(store);
  return job;
}

export async function reportRemoteAgentJob(input: {
  agentId: string;
  jobId: string;
  status: RemoteAgentJob["status"];
  pid?: number;
  tmuxSession?: string;
  exitCode?: number;
  logFile?: string;
  logTail?: string;
  providerState?: RemoteAgentJob["providerState"];
  artifactsDir?: string;
  handoffTitle?: string;
  progress?: string;
  todo?: string;
  notes?: string;
  error?: string;
  sentInputIds?: string[];
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  let job = store.jobs.find(
    (entry) => entry.jobId === input.jobId && entry.agentId === input.agentId,
  );
  const agent = store.agents.find((entry) => entry.agentId === input.agentId);
  const previousStatus = job?.status;
  const previousProviderState = job?.providerState?.state;

  if (!job) {
    if (!agent) {
      throw new Error(`Unknown remote agent: ${input.agentId}`);
    }

    const now = new Date().toISOString();
    job = {
      jobId: input.jobId,
      agentId: input.agentId,
      type: "start_agent",
      title: `Recovered remote job: ${input.jobId.replace(/^raj_/, "").slice(0, 8)}`,
      command: [],
      cwd: agent.worktree ?? agent.repoRoot ?? null,
      env: {},
      status: input.status,
      createdAt: now,
      updatedAt: now,
    };
    store.jobs.unshift(job);
    appendRemoteEvent(store, {
      type: "session.recovered",
      agentId: input.agentId,
      jobId: input.jobId,
      createdAt: now,
      metadata: {
        status: input.status,
      },
    });
  }

  const now = new Date().toISOString();
  job.status = input.status;
  job.updatedAt = now;
  if (input.status === "running" && !job.startedAt) job.startedAt = now;
  if (input.status === "completed" || input.status === "failed") job.completedAt = now;
  if (typeof input.pid === "number") job.pid = input.pid;
  if (typeof input.exitCode === "number") job.exitCode = input.exitCode;
  if (input.tmuxSession) job.tmuxSession = input.tmuxSession;
  if (input.logFile) job.logFile = input.logFile;
  if (typeof input.logTail === "string") job.logTail = input.logTail;
  if (input.providerState) {
    job.providerState = {
      ...input.providerState,
      updatedAt: now,
    };
  }
  if (previousStatus && previousStatus !== job.status) {
    appendRemoteEvent(store, {
      type: "session.status_changed",
      agentId: job.agentId,
      jobId: job.jobId,
      createdAt: now,
      severity: job.status === "failed" ? "error" : "info",
      metadata: {
        from: previousStatus,
        to: job.status,
      },
    });
  }
  if (job.providerState && previousProviderState !== job.providerState.state) {
    appendRemoteEvent(store, {
      type: "session.provider_state_changed",
      agentId: job.agentId,
      jobId: job.jobId,
      createdAt: now,
      severity:
        job.providerState.state === "blocked" || job.providerState.state === "waiting_approval"
          ? "attention"
          : "info",
      metadata: {
        from: previousProviderState ?? null,
        to: job.providerState.state,
        source: job.providerState.source,
        confidence: job.providerState.confidence,
      },
    });
  }
  if (input.artifactsDir) job.artifactsDir = input.artifactsDir;
  if (
    typeof input.progress === "string" ||
    typeof input.todo === "string" ||
    typeof input.notes === "string" ||
    typeof input.handoffTitle === "string"
  ) {
    job.handoff = {
      ...(job.handoff ?? {}),
      ...(typeof input.progress === "string" ? { progress: input.progress } : {}),
      ...(typeof input.todo === "string" ? { todo: input.todo } : {}),
      ...(typeof input.notes === "string" ? { notes: input.notes } : {}),
      ...(typeof input.handoffTitle === "string" ? { title: input.handoffTitle } : {}),
      updatedAt: now,
    };
    applyHandoffTitle(job);
  }
  if (input.error) job.error = input.error;
  if (needsCodexRestart(`${job.error ?? ""}\n${job.logTail ?? ""}`)) {
    job.restartRequiredAt = job.restartRequiredAt ?? now;
  }
  if (Array.isArray(input.sentInputIds) && input.sentInputIds.length > 0) {
    const sentIds = new Set(input.sentInputIds.map(String));
    const sentAt = now;
    const pending = job.pendingInputs ?? [];
    const newlySent = pending
      .filter((entry) => sentIds.has(entry.inputId))
      .map((entry) => ({ ...entry, sentAt }));
    job.pendingInputs = pending.filter((entry) => !sentIds.has(entry.inputId));
    job.inputHistory = [...newlySent, ...(job.inputHistory ?? [])].slice(0, 50);
  }

  if (agent) {
    agent.status = input.status === "failed" ? "failed" : "running";
    agent.lastSeenAt = now;
  }

  if (input.status === "completed" || input.status === "failed") {
    maybeQueueUsageLimitResume(store, job);
  }
  if (input.status === "completed") {
    maybeQueueRalphIteration(store, job);
  }
  maybeQueueCodexRestartResume(store, job);

  await writeStore(store);
  return job;
}

export async function getRemoteAgentJob(input: {
  jobId: string;
  agentId?: string;
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  const job = store.jobs.find((entry) => entry.jobId === input.jobId);
  if (!job) {
    throw new Error(`Unknown remote agent job: ${input.jobId}`);
  }
  if (input.agentId && job.agentId !== input.agentId) {
    throw new Error(`Remote job ${input.jobId} does not belong to agent ${input.agentId}`);
  }
  return job;
}

export async function exportRemoteAgentJob(input: {
  jobId: string;
  agentId?: string;
}): Promise<{ filename: string; content: string }> {
  const job = await getRemoteAgentJob(input);
  const safeTitle = (deriveHandoffTitle(job) || job.title || job.jobId)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const content = [
    `# PI Session Export: ${deriveHandoffTitle(job) || job.title}`,
    "",
    "## Metadata",
    "",
    `- Job: ${job.jobId}`,
    `- Agent: ${job.agentId}`,
    `- Status: ${job.status}`,
    `- CWD: ${job.cwd ?? "unknown"}`,
    `- Created: ${job.createdAt}`,
    `- Updated: ${job.updatedAt}`,
    `- Artifacts: ${job.artifactsDir ?? "not reported"}`,
    "",
    "## Resume Hint",
    "",
    "Use this bundle as the first prompt/context when resuming the session in PI.",
    "",
    "---",
    "",
    "## PROGRESS.md",
    "",
    job.handoff?.progress?.trim() || "_No PROGRESS.md content reported yet._",
    "",
    "---",
    "",
    "## TODO.md",
    "",
    job.handoff?.todo?.trim() || "_No TODO.md content reported yet._",
    "",
    "---",
    "",
    "## NOTES.md",
    "",
    job.handoff?.notes?.trim() || "_No NOTES.md content reported yet._",
    "",
  ].join("\n");
  return {
    filename: `${safeTitle || job.jobId}-pi-session.md`,
    content,
  };
}

export async function queueRemoteAgentJobInput(input: {
  agentId: string;
  jobId: string;
  text: string;
  submit?: boolean;
  key?: "escape";
}): Promise<RemoteAgentJob> {
  const store = await readStore();
  const job = store.jobs.find(
    (entry) => entry.jobId === input.jobId && entry.agentId === input.agentId,
  );
  if (!job) {
    throw new Error(`Unknown remote agent job: ${input.jobId}`);
  }
  if (job.status !== "running") {
    throw new Error("Remote job is not running");
  }
  const text = input.text;
  if (input.key !== "escape" && !text && !input.submit) {
    throw new Error("Input text is required");
  }
  const now = new Date().toISOString();
  job.pendingInputs = [
    ...(job.pendingInputs ?? []),
    {
      inputId: `rji_${randomUUID()}`,
      text,
      submit: input.submit ?? true,
      key: input.key,
      createdAt: now,
    },
  ];
  job.updatedAt = now;
  appendRemoteEvent(store, {
    type: "session.input_queued",
    agentId: job.agentId,
    jobId: job.jobId,
    createdAt: now,
    metadata: {
      submit: input.submit ?? true,
      key: input.key ?? null,
      hasText: Boolean(text),
    },
  });
  await writeStore(store);
  return job;
}

export async function pollRemoteAgent(agentId: string): Promise<{
  agent: RemoteAgentRecord;
  pendingRequests: RemoteApprovalRequestRecord[];
  resolvedRequests: RemoteApprovalRequestRecord[];
  pendingJobs: RemoteAgentJob[];
  jobs: RemoteAgentJob[];
}> {
  const store = await normalizeStore();
  const agent = store.agents.find((entry) => entry.agentId === agentId);
  if (!agent) {
    throw new Error(`Unknown remote agent: ${agentId}`);
  }

  agent.lastSeenAt = new Date().toISOString();
  await writeStore(store);

  return {
    agent,
    pendingRequests: store.requests.filter(
      (entry) => entry.agentId === agentId && entry.status === "open",
    ),
    resolvedRequests: store.requests.filter(
      (entry) => entry.agentId === agentId && entry.status !== "open",
    ),
    pendingJobs: store.jobs.filter((entry) => entry.agentId === agentId && isReadyToLaunch(entry)),
    jobs: store.jobs.filter((entry) => entry.agentId === agentId && !entry.archivedAt),
  };
}

export async function getRemoteApprovalOverview(): Promise<RemoteApprovalOverview> {
  const store = await normalizeStore();
  const requests = [...store.requests].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const agents: RemoteAgentSummary[] = store.agents
    .map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.displayName,
      projectLabel: agent.projectLabel,
      toolType: agent.toolType,
      hostLabel: agent.hostLabel,
      repoRoot: agent.repoRoot,
      branch: agent.branch,
      worktree: agent.worktree,
      stateFile: agent.stateFile,
      logFile: agent.logFile,
      status: agent.status,
      lastSeenAt: agent.lastSeenAt,
      permissionMode: agent.permissionMode,
      timeoutSeconds: agent.timeoutSeconds,
      pendingApprovalCount: requests.filter(
        (request) => request.agentId === agent.agentId && request.status === "open",
      ).length,
      connectionState: deriveConnectionState(agent),
      consecutiveFailures: agent.consecutiveFailures,
      lastError: agent.lastError,
      nextRetryAt: agent.nextRetryAt,
      relay: agent.relay,
      sessionHistory: agent.sessionHistory ?? [],
      authConnectors: agent.authConnectors ?? [],
    }))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      agents: agents.length,
      running: agents.filter((agent) => agent.status === "running").length,
      pending: requests.filter((request) => request.status === "open").length,
      failed: agents.filter((agent) => agent.status === "failed").length,
    },
    agents,
    requests,
    jobs: [...store.jobs]
      .filter((job) => !job.archivedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    events: [...(store.events ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 200),
    enrollments: activeEnrollments(store).map(serializeEnrollment),
    recentEnrollments: [...store.enrollments]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 12)
      .map(serializeEnrollment),
  };
}
