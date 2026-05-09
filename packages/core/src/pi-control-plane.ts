import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getProjectBaseDir, getObservabilityBaseDir } from "./paths.js";
import type { CreateIssueInput, PIProjectConfig, PISession, PITracker } from "./types.js";

export type PISessionState =
  | "queued"
  | "running"
  | "awaiting_user_input"
  | "awaiting_approval"
  | "blocked"
  | "review_ready"
  | "merged"
  | "failed";

export type PIRequestKind =
  | "example_request"
  | "scope_clarification"
  | "plan_approval"
  | "final_approval";

export type PIRequestStatus = "open" | "answered" | "approved" | "rejected";

export interface PIPendingQuestion {
  id: string;
  sessionId: string;
  kind: PIRequestKind;
  title: string;
  message: string;
  status: PIRequestStatus;
  createdAt: string;
  updatedAt: string;
  response?: string;
}

export interface PIExecutionState {
  sessionId: string;
  state: PISessionState;
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

export interface PISessionArtifacts {
  summary: string | null;
  pendingQuestions: PIPendingQuestion[];
  executionState: PIExecutionState | null;
  updatedAt: string | null;
}

export type PIGitHubAuthType = "personal_access_token" | "oauth";

export interface PIGitHubConnectorRecord {
  id: string;
  label: string;
  host: string;
  accountLogin: string;
  owner: string;
  repo: string;
  authType: PIGitHubAuthType;
  accessToken: string;
  tokenPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface PIGitHubConnectorStore {
  selectedConnectorId: string | null;
  connectors: PIGitHubConnectorRecord[];
}

interface PIGitHubOAuthStateRecord {
  state: string;
  projectId: string;
  returnTo: string;
  popup?: boolean;
  createdAt: string;
}

export interface PIIdeaInput {
  projectId: string;
  title: string;
  description: string;
  labels?: string[];
  priority?: "low" | "medium" | "high" | "critical";
  source?: "dashboard" | "api" | "telegram";
}

export interface PIIssueDraft extends CreateIssueInput {
  order: number;
  suggestedAgent: "codex" | "claude-code" | "cursor" | "opencode";
  stage: "intake" | "execution" | "approval";
}

export interface PIIdeaPlan {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  source: "dashboard" | "api" | "telegram";
  labels: string[];
  issues: PIIssueDraft[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePriority(
  priority: PIIdeaInput["priority"],
): "low" | "medium" | "high" | "critical" {
  return priority ?? "medium";
}

export function getPISessionDir(configPath: string, projectPath: string, sessionId: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "pi-state", sessionId);
}

function summaryPath(configPath: string, projectPath: string, sessionId: string): string {
  return join(getPISessionDir(configPath, projectPath, sessionId), "session-summary.md");
}

function questionsPath(configPath: string, projectPath: string, sessionId: string): string {
  return join(getPISessionDir(configPath, projectPath, sessionId), "pending-questions.json");
}

function executionPath(configPath: string, projectPath: string, sessionId: string): string {
  return join(getPISessionDir(configPath, projectPath, sessionId), "execution-state.json");
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

function defaultSummary(session: PISession, piState: PISessionState): string {
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
    "- PISession scaffold initialized.",
    "",
    "## Current diff / tests",
    "- No structured diff or test summary captured yet.",
    "",
    "## Blockers",
    piState === "blocked" ? "- PISession needs attention before resuming." : "- No blockers recorded.",
    "",
    "## Suggested next step",
    "Resume the session or reply from the PI dashboard.",
  ].join("\n");
}

function defaultExecutionState(session: PISession, piState: PISessionState): PIExecutionState {
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
        ? "Reply from the PI dashboard and send context back to the session."
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

function normalizeConnectorStore(store: PIGitHubConnectorStore): PIGitHubConnectorStore {
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

function normalizeOAuthStates(records: PIGitHubOAuthStateRecord[]): PIGitHubOAuthStateRecord[] {
  const cutoff = Date.now() - 1000 * 60 * 15;
  return records
    .filter((record) => new Date(record.createdAt).getTime() >= cutoff)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function derivePISessionState(
  session: Pick<PISession, "status" | "activity" | "pr">,
  pendingQuestions: PIPendingQuestion[] = [],
): PISessionState {
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

export async function readPISessionArtifacts(
  configPath: string,
  projectPath: string,
  sessionId: string,
): Promise<PISessionArtifacts> {
  const [summary, pendingQuestions, executionState] = await Promise.all([
    safeRead(summaryPath(configPath, projectPath, sessionId)),
    safeReadJson<PIPendingQuestion[]>(questionsPath(configPath, projectPath, sessionId), []),
    safeReadJson<PIExecutionState | null>(executionPath(configPath, projectPath, sessionId), null),
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

export async function ensurePISessionArtifacts(
  configPath: string,
  projectPath: string,
  session: PISession,
): Promise<void> {
  const dir = getPISessionDir(configPath, projectPath, session.id);
  await mkdir(dir, { recursive: true });

  const pendingQuestions = await safeReadJson<PIPendingQuestion[]>(
    questionsPath(configPath, projectPath, session.id),
    [],
  );
  const piState = derivePISessionState(session, pendingQuestions);

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

export async function writePISessionHandoff(
  configPath: string,
  projectPath: string,
  session: PISession,
  input: {
    summary: string;
    executionState: PIExecutionState;
    pendingQuestions?: PIPendingQuestion[];
  },
): Promise<void> {
  const dir = getPISessionDir(configPath, projectPath, session.id);
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

export async function upsertPIPendingQuestion(
  configPath: string,
  projectPath: string,
  sessionId: string,
  question: Omit<PIPendingQuestion, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<PIPendingQuestion> {
  const artifacts = await readPISessionArtifacts(configPath, projectPath, sessionId);
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

  await mkdir(getPISessionDir(configPath, projectPath, sessionId), { recursive: true });
  await writeFile(questionsPath(configPath, projectPath, sessionId), JSON.stringify(next, null, 2), "utf8");

  return nextQuestion;
}

export async function listPIGitHubConnectors(
  configPath: string,
  projectPath: string,
): Promise<PIGitHubConnectorStore> {
  const store = await safeReadJson<PIGitHubConnectorStore>(
    githubConnectorsPath(configPath, projectPath),
    {
      selectedConnectorId: null,
      connectors: [],
    },
  );
  return normalizeConnectorStore(store);
}

export async function getSelectedPIGitHubConnector(
  configPath: string,
  projectPath: string,
): Promise<PIGitHubConnectorRecord | null> {
  const store = await listPIGitHubConnectors(configPath, projectPath);
  if (!store.selectedConnectorId) return null;
  return store.connectors.find((connector) => connector.id === store.selectedConnectorId) ?? null;
}

export async function upsertPIGitHubConnector(
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
    authType?: PIGitHubAuthType;
    setAsSelected?: boolean;
  },
): Promise<PIGitHubConnectorStore> {
  const current = await listPIGitHubConnectors(configPath, projectPath);
  const now = nowIso();
  const existing = current.connectors.find((connector) => connector.id === input.id);
  const nextToken = input.accessToken?.trim() || existing?.accessToken || "";
  if (!nextToken) {
    throw new Error("GitHub connector access token is required");
  }
  const connector: PIGitHubConnectorRecord = existing
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

export async function createPIGitHubOAuthState(
  configPath: string,
  input: {
    projectId: string;
    returnTo: string;
    popup?: boolean;
  },
): Promise<string> {
  const records = normalizeOAuthStates(
    await safeReadJson<PIGitHubOAuthStateRecord[]>(githubOAuthStatesPath(configPath), []),
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

export async function consumePIGitHubOAuthState(
  configPath: string,
  state: string,
): Promise<{
  projectId: string;
  returnTo: string;
  popup: boolean;
} | null> {
  const current = normalizeOAuthStates(
    await safeReadJson<PIGitHubOAuthStateRecord[]>(githubOAuthStatesPath(configPath), []),
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

export async function selectPIGitHubConnector(
  configPath: string,
  projectPath: string,
  connectorId: string,
): Promise<PIGitHubConnectorStore> {
  const current = await listPIGitHubConnectors(configPath, projectPath);
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

export async function respondToPIPendingQuestion(
  configPath: string,
  projectPath: string,
  sessionId: string,
  requestId: string,
  response: string,
  action: "reply" | "approve" | "reject",
): Promise<PIPendingQuestion | null> {
  const artifacts = await readPISessionArtifacts(configPath, projectPath, sessionId);
  const existing = artifacts.pendingQuestions.find((item) => item.id === requestId);
  if (!existing) return null;

  const status: PIRequestStatus =
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

export function createPIIdeaPlan(input: PIIdeaInput): PIIdeaPlan {
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

export async function materializePIIdeaPlan(
  plan: PIIdeaPlan,
  tracker: PITracker,
  project: PIProjectConfig,
): Promise<Array<{ id: string; title: string; url: string; labels: string[] }>> {
  if (!tracker.createIssue) {
    throw new Error(`PITracker plugin "${tracker.name}" does not support issue creation`);
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
