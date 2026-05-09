import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  TERMINAL_STATUSES as PI_TERMINAL_STATUSES,
  getProjectBaseDir,
  type PISession,
} from "@pi/core";
import type { PIIdeaBoardColumnData, PIIdeaBoardData, PIIdeaCard, PIIdeaStatus } from "@/lib/types";
import { getServices } from "@/lib/services";
import type { PIConfig } from "@/lib/services";

// Alias for compatibility with original code that uses TERMINAL_STATUSES
const TERMINAL_STATUSES = PI_TERMINAL_STATUSES;


interface PIIdeaRecord {
  id: string;
  title: string;
  markdown: string;
  status: PIIdeaStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
  projectName?: string;
  projectSlug?: string;
  workspacePath?: string;
  sessionId?: string;
  sessionStatus?: string | null;
}

interface PIIdeaStore {
  ideas: PIIdeaRecord[];
}

const IDEA_COLUMNS: Array<{ id: PIIdeaStatus; title: string; description: string }> = [
  {
    id: "idea_bank",
    title: "Idea Bank",
    description: "Fresh markdown ideas waiting to be pulled into the project flow.",
  },
  {
    id: "project_queue",
    title: "Project Queue",
    description: "Queued ideas ready to be picked up by PI next.",
  },
  {
    id: "working",
    title: "Working",
    description: "Ideas PI is actively implementing right now.",
  },
  {
    id: "done",
    title: "Done",
    description: "Ideas that already produced an implementation pass.",
  },
];

const globalForPIIdeaExecution = globalThis as typeof globalThis & {
  _piIdeaSpawnLocks?: Map<string, Promise<PISession>>;
};

const DEFAULT_SERVER_EXECUTION_ROOT = "/srv/pi/workspaces";

function resolveIdeaExecutionRoot(): string {
  const explicit = process.env["PI_WORKSPACE_ROOT"]?.trim();
  if (explicit) return explicit;
  return DEFAULT_SERVER_EXECUTION_ROOT;
}

function slugifyProjectName(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "untitled-project";
}

function deriveIdeaWorkspace(idea: Pick<PIIdeaRecord, "id" | "title" | "projectSlug" | "workspacePath">) {
  const projectName = idea.title.trim() || "Untitled Project";
  const projectSlug = idea.projectSlug?.trim() || slugifyProjectName(projectName);
  const workspacePath = idea.workspacePath?.trim() || join(resolveIdeaExecutionRoot(), projectSlug);
  return {
    projectName,
    projectSlug,
    workspacePath,
  };
}

function getIdeaSpawnLocks(): Map<string, Promise<PISession>> {
  if (!globalForPIIdeaExecution._piIdeaSpawnLocks) {
    globalForPIIdeaExecution._piIdeaSpawnLocks = new Map<string, Promise<PISession>>();
  }
  return globalForPIIdeaExecution._piIdeaSpawnLocks;
}

function sessionTimestamp(session: PISession): number {
  return new Date(session.createdAt).getTime();
}

function ideasDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "pi-ideas");
}

function ideasPath(configPath: string, projectPath: string): string {
  return join(ideasDir(configPath, projectPath), "board.json");
}

function isIdeaStatus(value: string): value is PIIdeaStatus {
  return IDEA_COLUMNS.some((column) => column.id === value);
}

async function readIdeaStore(configPath: string, projectPath: string): Promise<PIIdeaStore> {
  try {
    const raw = await readFile(ideasPath(configPath, projectPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<PIIdeaStore>;
    return {
      ideas: Array.isArray(parsed.ideas)
        ? parsed.ideas
            .filter(
              (idea): idea is PIIdeaRecord =>
                Boolean(
                  idea &&
                    typeof idea.id === "string" &&
                    typeof idea.title === "string" &&
                    typeof idea.markdown === "string" &&
                    typeof idea.order === "number" &&
                    typeof idea.createdAt === "string" &&
                    typeof idea.updatedAt === "string" &&
                    typeof idea.status === "string" &&
                    isIdeaStatus(idea.status),
                ),
            )
            .map((idea) => ({
              ...idea,
              title: idea.title.trim(),
              markdown: idea.markdown,
              projectName:
                typeof idea.projectName === "string" ? idea.projectName.trim() : undefined,
              projectSlug:
                typeof idea.projectSlug === "string" ? idea.projectSlug.trim() : undefined,
              workspacePath:
                typeof idea.workspacePath === "string" ? idea.workspacePath.trim() : undefined,
            }))
        : [],
    };
  } catch {
    return { ideas: [] };
  }
}

function normalizeIdeaStore(store: PIIdeaStore): PIIdeaStore {
  const byColumn = new Map<PIIdeaStatus, PIIdeaRecord[]>(
    IDEA_COLUMNS.map((column) => [column.id, []]),
  );

  for (const idea of store.ideas) {
    const bucket = byColumn.get(idea.status);
    if (!bucket) continue;
      bucket.push({
        ...idea,
        title: idea.title.trim(),
        markdown: idea.markdown,
        ...deriveIdeaWorkspace(idea),
      });
  }

  for (const column of IDEA_COLUMNS) {
    byColumn.get(column.id)?.sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order;
      return left.createdAt.localeCompare(right.createdAt);
    });
  }

  const ideas: PIIdeaRecord[] = [];
  for (const column of IDEA_COLUMNS) {
    const records = byColumn.get(column.id) ?? [];
    records.forEach((idea, index) => {
      ideas.push({
        ...idea,
        status: column.id,
        order: index,
      });
    });
  }

  return { ideas };
}

async function writeIdeaStore(configPath: string, projectPath: string, store: PIIdeaStore): Promise<void> {
  await mkdir(ideasDir(configPath, projectPath), { recursive: true });
  await writeFile(
    ideasPath(configPath, projectPath),
    JSON.stringify(normalizeIdeaStore(store), null, 2),
    "utf8",
  );
}

function serializeIdea(idea: PIIdeaRecord): PIIdeaCard {
  return {
    id: idea.id,
    title: idea.title,
    markdown: idea.markdown,
    excerpt: idea.markdown.trim().slice(0, 180),
    status: idea.status,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
    sessionId: idea.sessionId,
    sessionStatus: idea.sessionStatus ?? null,
  };
}

function buildIdeaPrompt(idea: Pick<PIIdeaRecord, "id" | "title" | "markdown">): string {
  const workspace = deriveIdeaWorkspace(idea);
  return [
    `[PI_IDEA_ID:${idea.id}]`,
    `[PI_IDEA_TITLE:${idea.title}]`,
    `[PI_PROJECT_NAME:${workspace.projectName}]`,
    "",
    "Implement the following idea from the PI idea factory.",
    "",
    `Project name: ${workspace.projectName}`,
    `Workspace folder: ${workspace.workspacePath}`,
    "Treat this workspace folder as the project root for the implementation.",
    "If the folder is empty, initialize the project there and continue working inside it.",
    "Do not drift back to the PI control-plane repo unless the idea explicitly asks you to change PI itself.",
    "",
    idea.markdown,
  ].join("\n");
}

function buildApprovalInstruction(sessionId: string, workspacePath: string): string {
  const requestTemplate = JSON.stringify({
    sessionId,
    kind: "plan_approval",
    title: "Approve implementation plan",
    message:
      `Summarize exactly what you plan to build next, which folder/files you will touch under ${workspacePath}, and why this is the right first pass.`,
  });

  return [
    "PI approval channel is available for this session.",
    "Before you implement anything, inspect the task and immediately POST a concrete `plan_approval` request to the local PI endpoint.",
    "That request must summarize:",
    "- what you are going to build first",
    `- which folder/files under ${workspacePath} you expect to create or edit`,
    "- any important assumptions or risks",
    "- how you plan to verify the first pass",
    "",
    "After you POST the approval request, stop and wait. Do not begin implementation until PI sends an approval or a follow-up reply.",
    "",
    "Endpoint:",
    "http://127.0.0.1:3000/api/pi/requests/create",
    "",
    "Use one of these kinds:",
    "- example_request",
    "- scope_clarification",
    "- plan_approval",
    "- final_approval",
    "",
    "Request body template:",
    requestTemplate,
  ].join("\n");
}

function findIdeaSessions(sessions: PISession[], projectId: string, ideaId: string): PISession[] {
  return sessions
    .filter((session) => {
      if (session.projectId !== projectId) return false;
      const prompt = session.metadata["userPrompt"] ?? "";
      return prompt.includes(`[PI_IDEA_ID:${ideaId}]`);
    })
    .sort((left, right) => sessionTimestamp(left) - sessionTimestamp(right));
}

function findActiveIdeaSession(sessions: PISession[], projectId: string, ideaId: string): PISession | null {
  return findIdeaSessions(sessions, projectId, ideaId).find(
    (session) => !TERMINAL_STATUSES.has(session.status),
  ) ?? null;
}

function findLatestIdeaSession(sessions: PISession[], projectId: string, ideaId: string): PISession | null {
  const matches = findIdeaSessions(sessions, projectId, ideaId);
  return matches.at(-1) ?? null;
}

async function spawnIdeaSession(
  sessionManager: Awaited<ReturnType<typeof getServices>>["sessionManager"],
  projectId: string,
  idea: PIIdeaRecord,
): Promise<PISession> {
  const lockKey = `${projectId}:${idea.id}`;
  const locks = getIdeaSpawnLocks();
  const pending = locks.get(lockKey);
  if (pending) return pending;

  const task = (async () => {
    const latestSessions = await sessionManager.list(projectId);
    const existing = findActiveIdeaSession(latestSessions, projectId, idea.id);
    if (existing) return existing;
    const workspace = deriveIdeaWorkspace(idea);
    await mkdir(workspace.workspacePath, { recursive: true });
    const spawned = await sessionManager.spawn({
      projectId,
      prompt: buildIdeaPrompt(idea),
      workspacePathOverride: workspace.workspacePath,
    });
    try {
      await sessionManager.send(
        spawned.id,
        buildApprovalInstruction(spawned.id, workspace.workspacePath),
      );
    } catch (error) {
      console.error(
        `[pi-ideas] Failed to send approval instructions to ${spawned.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return spawned;
  })();

  locks.set(lockKey, task);
  try {
    return await task;
  } finally {
    if (locks.get(lockKey) === task) {
      locks.delete(lockKey);
    }
  }
}

async function _ensureIdeaExecution(
  config: PIConfig,
  projectId: string,
  store: PIIdeaStore,
): Promise<PIIdeaStore> {
  const { sessionManager } = await getServices();
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const sessions = await sessionManager.list(projectId);
  let mutated = false;

  for (const idea of store.ideas) {
    if (idea.status !== "working") {
      if (idea.sessionStatus) {
        idea.sessionStatus = null;
        mutated = true;
      }
      continue;
    }

    const existing = findActiveIdeaSession(sessions, projectId, idea.id);
    if (existing) {
      if (idea.sessionId !== existing.id || idea.sessionStatus !== existing.status) {
        idea.sessionId = existing.id;
        idea.sessionStatus = existing.status;
        Object.assign(idea, deriveIdeaWorkspace(idea));
        mutated = true;
      }
      continue;
    }

    const latest = findLatestIdeaSession(sessions, projectId, idea.id);
    if (latest && TERMINAL_STATUSES.has(latest.status)) {
      if (idea.sessionId !== latest.id || idea.sessionStatus !== latest.status) {
        idea.sessionId = latest.id;
        idea.sessionStatus = latest.status;
        Object.assign(idea, deriveIdeaWorkspace(idea));
      }
    }

    const spawned = await spawnIdeaSession(sessionManager, projectId, idea);
    idea.sessionId = spawned.id;
    idea.sessionStatus = spawned.status;
    Object.assign(idea, deriveIdeaWorkspace(idea));
    idea.updatedAt = new Date().toISOString();
    mutated = true;
  }

  return mutated ? normalizeIdeaStore(store) : store;
}

function toBoard(projectId: string, store: PIIdeaStore): PIIdeaBoardData {
  const normalized = normalizeIdeaStore(store);
  const ideasByStatus = new Map<PIIdeaStatus, PIIdeaCard[]>(
    IDEA_COLUMNS.map((column) => [column.id, []]),
  );

  for (const idea of normalized.ideas) {
    ideasByStatus.get(idea.status)?.push(serializeIdea(idea));
  }

  const columns: PIIdeaBoardColumnData[] = IDEA_COLUMNS.map((column) => ({
    id: column.id,
    title: column.title,
    description: column.description,
    ideas: ideasByStatus.get(column.id) ?? [],
  }));

  return {
    projectId,
    generatedAt: new Date().toISOString(),
    columns,
  };
}

async function resolveProjectConfig(config: PIConfig, projectId: string) {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  if (!config.configPath) {
    throw new Error("PI config path is not available");
  }
  return {
    configPath: config.configPath,
    projectPath: project.path,
  };
}

export async function resolvePIIdeaProjectId(projectId?: string | null): Promise<string> {
  const { config } = await getServices();
  if (projectId && config.projects[projectId]) return projectId;
  const firstProjectId = Object.keys(config.projects)[0];
  if (!firstProjectId) {
    throw new Error("No PI execution project is configured");
  }
  return firstProjectId;
}

export function getPIIdeaExecutionRoot(): string {
  return resolveIdeaExecutionRoot();
}

export async function getPIIdeaBoard(projectId: string): Promise<PIIdeaBoardData> {
  const { config } = await getServices();
  const resolved = await resolveProjectConfig(config, projectId);
  const store = await readIdeaStore(resolved.configPath, resolved.projectPath);
  const normalized = normalizeIdeaStore(store);
  await writeIdeaStore(resolved.configPath, resolved.projectPath, normalized);
  return toBoard(projectId, normalized);
}

export async function createPIIdea(input: {
  projectId: string;
  title: string;
  markdown: string;
}): Promise<PIIdeaBoardData> {
  const { config } = await getServices();
  const resolved = await resolveProjectConfig(config, input.projectId);
  const store = normalizeIdeaStore(
    await readIdeaStore(resolved.configPath, resolved.projectPath),
  );
  const now = new Date().toISOString();
  const ideaBankCount = store.ideas.filter((idea) => idea.status === "idea_bank").length;

  store.ideas.push({
    id: `idea_${randomUUID()}`,
    title: input.title.trim(),
    markdown: input.markdown,
    status: "idea_bank",
    order: ideaBankCount,
    createdAt: now,
    updatedAt: now,
    projectName: input.title.trim(),
    projectSlug: slugifyProjectName(input.title.trim()),
    workspacePath: join(resolveIdeaExecutionRoot(), slugifyProjectName(input.title.trim())),
  });

  await writeIdeaStore(resolved.configPath, resolved.projectPath, store);
  return getPIIdeaBoard(input.projectId);
}

export async function updatePIIdea(input: {
  projectId: string;
  ideaId: string;
  title: string;
  markdown: string;
}): Promise<PIIdeaBoardData> {
  const { config } = await getServices();
  const resolved = await resolveProjectConfig(config, input.projectId);
  const store = normalizeIdeaStore(
    await readIdeaStore(resolved.configPath, resolved.projectPath),
  );
  const target = store.ideas.find((idea) => idea.id === input.ideaId);
  if (!target) {
    throw new Error(`Unknown idea: ${input.ideaId}`);
  }

  target.title = input.title.trim();
  target.markdown = input.markdown;
  target.projectName = input.title.trim();
  target.updatedAt = new Date().toISOString();

  await writeIdeaStore(resolved.configPath, resolved.projectPath, store);
  return getPIIdeaBoard(input.projectId);
}

export async function movePIIdeas(input: {
  projectId: string;
  columns: Record<PIIdeaStatus, string[]>;
}): Promise<PIIdeaBoardData> {
  const { config } = await getServices();
  const resolved = await resolveProjectConfig(config, input.projectId);
  const store = normalizeIdeaStore(
    await readIdeaStore(resolved.configPath, resolved.projectPath),
  );
  const ideasById = new Map(store.ideas.map((idea) => [idea.id, idea]));
  const touched = new Set<string>();
  const now = new Date().toISOString();

  for (const column of IDEA_COLUMNS) {
    const orderedIds = input.columns[column.id] ?? [];
    orderedIds.forEach((ideaId, index) => {
      const idea = ideasById.get(ideaId);
      if (!idea) return;
      idea.status = column.id;
      idea.order = index;
      idea.updatedAt = now;
      touched.add(ideaId);
    });
  }

  for (const idea of store.ideas) {
    if (touched.has(idea.id)) continue;
  }

  await writeIdeaStore(resolved.configPath, resolved.projectPath, store);
  return getPIIdeaBoard(input.projectId);
}
