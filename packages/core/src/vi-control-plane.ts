import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getProjectBaseDir, getObservabilityBaseDir } from "./paths.js";
import type { CreateIssueInput, VIProjectConfig, VISession, VITracker } from "./types.js";

export type VISessionState =
  | "queued"
  | "running"
  | "awaiting_user_input"
  | "awaiting_approval"
  | "blocked"
  | "review_ready"
  | "merged"
  | "failed";

export type VIRequestKind =
  | "example_request"
  | "scope_clarification"
  | "plan_approval"
  | "final_approval";

export type VIRequestStatus = "open" | "answered" | "approved" | "rejected";

export interface PIPendingQuestion {
  id: string;
  sessionId: string;
  kind: VIRequestKind;
  title: string;
  message: string;
  status: VIRequestStatus;
  createdAt: string;
  updatedAt: string;
  response?: string;
}

export interface VIExecutionState {
  sessionId: string;
  state: VISessionState;
  updatedAt: string;
  currentGoal: string;
  lastUpdate: string;
  nextSuggestedAction: string;
  restoreCommand: string;
  checkpoints: Array<{
    timestamp: string;
    label: string;
    detail?: string;
  }>;
}

export interface VISessionArtifacts {
  summary: string | null;
  pendingQuestions: PIPendingQuestion[];
  executionState: VIExecutionState | null;
  updatedAt: string | null;
}

export type VIGitHubAuthType = "personal_access_token" | "oauth";

export interface VIGitHubConnectorRecord {
  id: string;
  label: string;
  host: string;
  accountLogin: string;
  owner: string;
  repo: string;
  authType: VIGitHubAuthType;
  accessToken: string;
  tokenPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface VIGitHubConnectorStore {
  selectedConnectorId: string | null;
  connectors: VIGitHubConnectorRecord[];
}

interface VIGitHubOAuthStateRecord {
  state: string;
  projectId: string;
  returnTo: string;
  popup?: boolean;
  createdAt: string;
}

export interface VIIdeaInput {
  projectId: string;
  title: string;
  description: string;
  labels?: string[];
  priority?: "low" | "medium" | "high" | "critical";
  source?: "dashboard" | "api" | "telegram";
}

export interface VIIssueDraft extends CreateIssueInput {
  order: number;
  suggestedAgent: "codex" | "claude-code" | "cursor" | "opencode";
  stage: "intake" | "execution" | "approval";
}

export interface VIIdeaPlan {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  source: "dashboard" | "api" | "telegram";
  labels: string[];
  issues: VIIssueDraft[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePriority(
  priority: VIIdeaInput["priority"],
): "low" | "medium" | "high" | "critical" {
  return priority ?? "medium";
}

export function getVISessionDir(configPath: string, projectPath: string, sessionId: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "pi-state", sessionId);
}

function summaryPath(configPath: string, projectPath: string, sessionId: string): string {
  return join(getVISessionDir(configPath, projectPath, sessionId), "session-summary.md");
}

function questionsPath(configPath: string, projectPath: string, sessionId: string): string {
  return join(getVISessionDir(configPath, projectPath, sessionId), "pending-questions.json");
}

function executionPath(configPath: string, projectPath: string, sessionId: string): string {
  return join(getVISessionDir(configPath, projectPath, sessionId), "execution-state.json");
}

function githubConnectorsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "pi-connectors");
}

function githubConnectorsPath(configPath: string, projectPath: string): string {
  return join(githubConnectorsDir(configPath, projectPath), "github-connectors.json");
}

function githubOAuthStatesDir(configPath: string): string {
  return join(getObservabilityBaseDir(configPath), "pi-connectors");
}

function githubOAuthStatesPath(configPath: string): string {
  return join(githubOAuthStatesDir(configPath), "github-oauth-states.json");
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function safeReadJson<T>(filePath: string, fallback: T): Promise<T> {
  const content = await safeRead(filePath);
  if (!content) return fallback;
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function defaultSummary(session: VISession, piState: VISessionState): string {
  return [
    `# ${session.id}`,
    "",
    `- Project: ${session.projectId}`,
    `- PI state: ${piState}`,
    `- Status: ${session.status}`,
    `- Branch: ${session.branch ?? "not created yet"}`,
    `- Issue: ${session.issueId ?? "ad-hoc task"}`,
    `- PR: ${session.pr?.url ?? "not opened yet"}`,
    "",
    "## Current goal",
    session.agentInfo?.summary ??
      session.metadata["summary"] ??
      session.metadata["userPrompt"] ??
      "Continue execution on the current task.",
    "",
    "## Completed",
    "- VISession scaffold initialized.",
    "",
    "## Current diff / tests",
    "- No structured diff or test summary captured yet.",
    "",
    "## Blockers",
    piState === "blocked" ? "- VISession needs attention before resuming." : "- No blockers recorded.",
    "",
    "## Suggested next step",
    "Resume the session or reply from the VI dashboard.",
  ].join("\n");
}

function defaultExecutionState(session: VISession, piState: VISessionState): VIExecutionState {
  return {
    sessionId: session.id,
    state: piState,
    updatedAt: nowIso(),
    currentGoal:
      session.agentInfo?.summary ??
      session.metadata["summary"] ??
      session.metadata["userPrompt"] ??
      "Continue current execution.",
    lastUpdate: `PI status ${session.status}`,
    nextSuggestedAction:
      piState === "awaiting_user_input" || piState === "awaiting_approval"
        ? "Reply from the VI dashboard and send context back to the session."
        : piState === "blocked"
          ? "Inspect the session and restore if needed."
          : piState === "review_ready"
            ? "Review the PR and merge or send follow-up."
            : "Let the session continue running.",
    restoreCommand: `pi session restore ${session.id}`,
    checkpoints: [],
  };
}

function sortQuestions(questions: PIPendingQuestion[]): PIPendingQuestion[] {
  return [...questions].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function sanitizeTokenPreview(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function normalizeConnectorStore(store: VIGitHubConnectorStore): VIGitHubConnectorStore {
  const connectors = [...store.connectors].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const selectedConnectorId =
    store.selectedConnectorId && connectors.some((connector) => connector.id === store.selectedConnectorId)
      ? store.selectedConnectorId
      : connectors[0]?.id ?? null;

  return {
    selectedConnectorId,
    connectors,
  };
}

function normalizeOAuthStates(records: VIGitHubOAuthStateRecord[]): VIGitHubOAuthStateRecord[] {
  const cutoff = Date.now() - 1000 * 60 * 15;
  return records
    .filter((record) => new Date(record.createdAt).getTime() >= cutoff)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function deriveVISessionState(
  session: Pick<VISession, "status" | "activity" | "pr">,
  pendingQuestions: PIPendingQuestion[] = [],
): VISessionState {
  const openQuestions = pendingQuestions.filter((question) => question.status === "open");
  const approvalRequested = openQuestions.some(
    (question) => question.kind === "plan_approval" || question.kind === "final_approval",
  );

  if (session.status === "merged") {
    return "merged";
  }

  if (
    session.status === "errored" ||
    session.status === "terminated" ||
    session.status === "killed" ||
    session.status === "cleanup" ||
    session.status === "done"
  ) {
    return "failed";
  }

  if (session.status === "spawning" && session.activity === null) {
    return "queued";
  }

  if (session.status === "approved" || session.status === "mergeable") {
    return "review_ready";
  }

  if (
    session.status === "needs_input" ||
    session.activity === "waiting_input" ||
    openQuestions.length > 0
  ) {
    return approvalRequested ? "awaiting_approval" : "awaiting_user_input";
  }

  if (
    session.status === "stuck" ||
    session.status === "ci_failed" ||
    session.status === "changes_requested" ||
    session.activity === "blocked" ||
    session.activity === "exited"
  ) {
    return "blocked";
  }

  return "running";
}

export async function readVISessionArtifacts(
  configPath: string,
  projectPath: string,
  sessionId: string,
): Promise<VISessionArtifacts> {
  const [summary, pendingQuestions, executionState] = await Promise.all([
    safeRead(summaryPath(configPath, projectPath, sessionId)),
    safeReadJson<PIPendingQuestion[]>(questionsPath(configPath, projectPath, sessionId), []),
    safeReadJson<VIExecutionState | null>(executionPath(configPath, projectPath, sessionId), null),
  ]);

  let updatedAt: string | null = null;
  try {
    updatedAt = (await stat(executionPath(configPath, projectPath, sessionId))).mtime.toISOString();
  } catch {
    void 0;
  }

  return {
    summary,
    pendingQuestions: sortQuestions(pendingQuestions),
    executionState,
    updatedAt,
  };
}

export async function ensureVISessionArtifacts(
  configPath: string,
  projectPath: string,
  session: VISession,
): Promise<void> {
  const dir = getVISessionDir(configPath, projectPath, session.id);
  await mkdir(dir, { recursive: true });

  const pendingQuestions = await safeReadJson<PIPendingQuestion[]>(
    questionsPath(configPath, projectPath, session.id),
    [],
  );
  const piState = deriveVISessionState(session, pendingQuestions);

  if (!existsSync(summaryPath(configPath, projectPath, session.id))) {
    await writeFile(summaryPath(configPath, projectPath, session.id), defaultSummary(session, piState), "utf8");
  }

  if (!existsSync(questionsPath(configPath, projectPath, session.id))) {
    await writeFile(
      questionsPath(configPath, projectPath, session.id),
      JSON.stringify(pendingQuestions, null, 2),
      "utf8",
    );
  }

  if (!existsSync(executionPath(configPath, projectPath, session.id))) {
    await writeFile(
      executionPath(configPath, projectPath, session.id),
      JSON.stringify(defaultExecutionState(session, piState), null, 2),
      "utf8",
    );
  }
}

export async function writeVISessionHandoff(
  configPath: string,
  projectPath: string,
  session: VISession,
  input: {
    summary: string;
    executionState: VIExecutionState;
    pendingQuestions?: PIPendingQuestion[];
  },
): Promise<void> {
  const dir = getVISessionDir(configPath, projectPath, session.id);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(summaryPath(configPath, projectPath, session.id), input.summary, "utf8"),
    writeFile(
      executionPath(configPath, projectPath, session.id),
      JSON.stringify(input.executionState, null, 2),
      "utf8",
    ),
    writeFile(
      questionsPath(configPath, projectPath, session.id),
      JSON.stringify(sortQuestions(input.pendingQuestions ?? []), null, 2),
      "utf8",
    ),
  ]);
}

export async function upsertVIPendingQuestion(
  configPath: string,
  projectPath: string,
  sessionId: string,
  question: Omit<PIPendingQuestion, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<PIPendingQuestion> {
  const artifacts = await readVISessionArtifacts(configPath, projectPath, sessionId);
  const existing = artifacts.pendingQuestions.find((item) => item.id === question.id);
  const now = nowIso();
  const nextQuestion: PIPendingQuestion = existing
    ? {
        ...existing,
        ...question,
        updatedAt: now,
      }
    : {
        id: question.id ?? `piq_${randomUUID()}`,
        sessionId,
        kind: question.kind,
        title: question.title,
        message: question.message,
        status: question.status,
        createdAt: now,
        updatedAt: now,
        response: question.response,
      };

  const remaining = artifacts.pendingQuestions.filter((item) => item.id !== nextQuestion.id);
  const next = sortQuestions([...remaining, nextQuestion]);

  await mkdir(getVISessionDir(configPath, projectPath, sessionId), { recursive: true });
  await writeFile(questionsPath(configPath, projectPath, sessionId), JSON.stringify(next, null, 2), "utf8");

  return nextQuestion;
}

export async function listVIGitHubConnectors(
  configPath: string,
  projectPath: string,
): Promise<VIGitHubConnectorStore> {
  const store = await safeReadJson<VIGitHubConnectorStore>(
    githubConnectorsPath(configPath, projectPath),
    {
      selectedConnectorId: null,
      connectors: [],
    },
  );
  return normalizeConnectorStore(store);
}

export async function getSelectedVIGitHubConnector(
  configPath: string,
  projectPath: string,
): Promise<VIGitHubConnectorRecord | null> {
  const store = await listVIGitHubConnectors(configPath, projectPath);
  if (!store.selectedConnectorId) return null;
  return store.connectors.find((connector) => connector.id === store.selectedConnectorId) ?? null;
}

export async function upsertVIGitHubConnector(
  configPath: string,
  projectPath: string,
  input: {
    id?: string;
    label: string;
    host?: string;
    accountLogin: string;
    owner: string;
    repo: string;
    accessToken?: string;
    authType?: VIGitHubAuthType;
    setAsSelected?: boolean;
  },
): Promise<VIGitHubConnectorStore> {
  const current = await listVIGitHubConnectors(configPath, projectPath);
  const now = nowIso();
  const existing = current.connectors.find((connector) => connector.id === input.id);
  const nextToken = input.accessToken?.trim() || existing?.accessToken || "";
  if (!nextToken) {
    throw new Error("GitHub connector access token is required");
  }
  const connector: VIGitHubConnectorRecord = existing
      ? {
          ...existing,
          label: input.label.trim(),
          host: (input.host ?? existing.host).trim() || "github.com",
          accountLogin: input.accountLogin.trim(),
          owner: input.owner.trim(),
          repo: input.repo.trim(),
          authType: input.authType ?? existing.authType,
          accessToken: nextToken,
          tokenPreview: sanitizeTokenPreview(nextToken),
          updatedAt: now,
        }
      : {
          id: input.id ?? `ghc_${randomUUID()}`,
          label: input.label.trim(),
          host: (input.host ?? "github.com").trim() || "github.com",
          accountLogin: input.accountLogin.trim(),
          owner: input.owner.trim(),
          repo: input.repo.trim(),
          authType: input.authType ?? "personal_access_token",
          accessToken: nextToken,
          tokenPreview: sanitizeTokenPreview(nextToken),
          createdAt: now,
          updatedAt: now,
        };

  const connectors = current.connectors.filter((item) => item.id !== connector.id);
  const next = normalizeConnectorStore({
    selectedConnectorId:
      input.setAsSelected === false
        ? current.selectedConnectorId
        : connector.id,
    connectors: [...connectors, connector],
  });

  await mkdir(githubConnectorsDir(configPath, projectPath), { recursive: true });
  await writeFile(githubConnectorsPath(configPath, projectPath), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function createVIGitHubOAuthState(
  configPath: string,
  input: {
    projectId: string;
    returnTo: string;
    popup?: boolean;
  },
): Promise<string> {
  const records = normalizeOAuthStates(
    await safeReadJson<VIGitHubOAuthStateRecord[]>(githubOAuthStatesPath(configPath), []),
  );
  const state = `gho_${randomUUID()}`;
  const next = normalizeOAuthStates([
    ...records,
    {
        state,
        projectId: input.projectId,
        returnTo: input.returnTo,
        popup: input.popup === true,
        createdAt: nowIso(),
      },
  ]);

  await mkdir(githubOAuthStatesDir(configPath), { recursive: true });
  await writeFile(githubOAuthStatesPath(configPath), JSON.stringify(next, null, 2), "utf8");
  return state;
}

export async function consumeVIGitHubOAuthState(
  configPath: string,
  state: string,
): Promise<{
  projectId: string;
  returnTo: string;
  popup: boolean;
} | null> {
  const current = normalizeOAuthStates(
    await safeReadJson<VIGitHubOAuthStateRecord[]>(githubOAuthStatesPath(configPath), []),
  );
  const match = current.find((record) => record.state === state);
  const next = current.filter((record) => record.state !== state);

  await mkdir(githubOAuthStatesDir(configPath), { recursive: true });
  await writeFile(githubOAuthStatesPath(configPath), JSON.stringify(next, null, 2), "utf8");

  if (!match) return null;
  return {
    projectId: match.projectId,
    returnTo: match.returnTo,
    popup: match.popup === true,
  };
}

export async function selectVIGitHubConnector(
  configPath: string,
  projectPath: string,
  connectorId: string,
): Promise<VIGitHubConnectorStore> {
  const current = await listVIGitHubConnectors(configPath, projectPath);
  if (!current.connectors.some((connector) => connector.id === connectorId)) {
    throw new Error(`Unknown GitHub connector: ${connectorId}`);
  }

  const next = normalizeConnectorStore({
    ...current,
    selectedConnectorId: connectorId,
  });

  await mkdir(githubConnectorsDir(configPath, projectPath), { recursive: true });
  await writeFile(githubConnectorsPath(configPath, projectPath), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function respondToVIPendingQuestion(
  configPath: string,
  projectPath: string,
  sessionId: string,
  requestId: string,
  response: string,
  action: "reply" | "approve" | "reject",
): Promise<PIPendingQuestion | null> {
  const artifacts = await readVISessionArtifacts(configPath, projectPath, sessionId);
  const existing = artifacts.pendingQuestions.find((item) => item.id === requestId);
  if (!existing) return null;

  const status: VIRequestStatus =
    action === "approve" ? "approved" : action === "reject" ? "rejected" : "answered";

  const nextQuestion: PIPendingQuestion = {
    ...existing,
    status,
    response,
    updatedAt: nowIso(),
  };

  const next = artifacts.pendingQuestions.map((item) =>
    item.id === requestId ? nextQuestion : item,
  );

  await writeFile(questionsPath(configPath, projectPath, sessionId), JSON.stringify(next, null, 2), "utf8");
  return nextQuestion;
}

export function createVIIdeaPlan(input: VIIdeaInput): VIIdeaPlan {
  const labels = [...new Set(["pi:intake", "agent:backlog", ...(input.labels ?? [])])];
  const priority = normalizePriority(input.priority);
  const title = input.title.trim();
  const description = input.description.trim();

  return {
    id: `idea_${randomUUID()}`,
    projectId: input.projectId,
    title,
    description,
    priority,
    source: input.source ?? "dashboard",
    labels,
    issues: [
      {
        order: 1,
        stage: "intake",
        suggestedAgent: "codex",
        title: `${title}: intake and issue generation`,
        description: [
          `Source idea: ${title}`,
          "",
          description,
          "",
          "Deliverables:",
          "- Capture the idea through PI intake.",
          "- Expand it into GitHub-ready issues and labels.",
          "- Feed created issues into the backlog.",
        ].join("\n"),
        labels: [...labels, "pi:intake", `priority:${priority}`],
      },
      {
        order: 2,
        stage: "execution",
        suggestedAgent: "claude-code",
        title: `${title}: scheduler and execution policy`,
        description: [
          `Source idea: ${title}`,
          "",
          "Deliverables:",
          "- Define concurrency and budget gates.",
          "- Handle provider rate limits and retries.",
          "- Advance backlog work automatically as capacity opens.",
        ].join("\n"),
        labels: [...labels, "pi:scheduler", `priority:${priority}`],
      },
      {
        order: 3,
        stage: "approval",
        suggestedAgent: "codex",
        title: `${title}: approvals, recovery, and dashboard flow`,
        description: [
          `Source idea: ${title}`,
          "",
          "Deliverables:",
          "- Surface pending questions and approvals in the PI inbox.",
          "- Persist session handoff files for restore.",
          "- Expose restore and review-ready actions in the dashboard.",
        ].join("\n"),
        labels: [...labels, "pi:hitl", "pi:recovery", `priority:${priority}`],
      },
    ],
  };
}

export async function materializeVIIdeaPlan(
  plan: VIIdeaPlan,
  tracker: VITracker,
  project: VIProjectConfig,
): Promise<Array<{ id: string; title: string; url: string; labels: string[] }>> {
  if (!tracker.createIssue) {
    throw new Error(`VITracker plugin "${tracker.name}" does not support issue creation`);
  }

  const created = [];
  for (const issue of plan.issues) {
    const result = await tracker.createIssue(
      {
        title: issue.title,
        description: issue.description,
        labels: issue.labels,
      },
      project,
    );

    created.push({
      id: result.id,
      title: result.title,
      url: result.url,
      labels: result.labels,
    });
  }
  return created;
}
