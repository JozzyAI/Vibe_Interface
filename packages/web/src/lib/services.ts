import "server-only";

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listPISessions,
  upsertPISession,
  getPIProjectBaseDir,
  type PISession,
  type PISessionStatus,
} from "@pi/core";

// ---------------------------------------------------------------------------
// PI project config
// ---------------------------------------------------------------------------

export interface PIProjectConfig {
  id: string;
  name?: string;
  path: string;
  sessionPrefix?: string;
  repo?: string;
}

export interface PIConfig {
  configPath: string;
  projects: Record<string, PIProjectConfig>;
}

function loadPIConfig(): PIConfig {
  const workspaceRoot = process.env["PI_WORKSPACE_ROOT"] ?? join(homedir(), "pi-workspace");
  const primaryProjectId = process.env["PI_PROJECT_ID"] ?? "default";
  const primaryProjectName = process.env["PI_PROJECT_NAME"] ?? "PI";

  return {
    configPath: join(homedir(), ".pi"),
    projects: {
      [primaryProjectId]: {
        id: primaryProjectId,
        name: primaryProjectName,
        path: workspaceRoot,
        sessionPrefix: primaryProjectId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// PI session manager
// ---------------------------------------------------------------------------

export interface PISessionManager {
  list: (projectId?: string) => Promise<PISession[]>;
  get: (sessionId: string) => Promise<PISession | null>;
  spawn: (input: {
    projectId: string;
    prompt?: string;
    workspacePathOverride?: string;
    issueId?: string;
  }) => Promise<PISession>;
  send: (sessionId: string, _message: string) => Promise<void>;
}

function createPISessionManager(config: PIConfig): PISessionManager {
  return {
    async list(projectId?: string): Promise<PISession[]> {
      const all = await listPISessions();
      if (!projectId || projectId === "all") return all;
      return all.filter((s) => s.projectId === projectId);
    },

    async get(sessionId: string): Promise<PISession | null> {
      const all = await listPISessions();
      return all.find((s) => s.id === sessionId) ?? null;
    },

    async spawn(input: {
      projectId: string;
      prompt?: string;
      workspacePathOverride?: string;
      issueId?: string;
    }): Promise<PISession> {
      const project = config.projects[input.projectId];
      const now = new Date().toISOString();
      const session: PISession = {
        id: `session_${randomUUID()}`,
        title: input.prompt
          ? input.prompt.split("\n")[0]?.slice(0, 80) ?? "Untitled session"
          : "Untitled session",
        projectId: input.projectId,
        issueId: input.issueId,
        status: "spawning" as PISessionStatus,
        activity: null,
        branch: null,
        pr: null,
        tool: process.env["PI_DEFAULT_AGENT"] ?? "claude-code",
        budget: { estimatedTokens: 0, estimatedUsd: 0 },
        lastUpdate: "Queued for agent",
        createdAt: now,
        updatedAt: now,
        agentInfo: null,
        metadata: {
          ...(input.prompt ? { userPrompt: input.prompt } : {}),
          ...(input.workspacePathOverride
            ? { workspacePath: input.workspacePathOverride }
            : { workspacePath: project?.path ?? getPIProjectBaseDir(input.projectId) }),
        },
      };
      await upsertPISession(session);
      return session;
    },

    async send(_sessionId: string, _message: string): Promise<void> {
      // Stub: in a real implementation this would deliver the message to the agent process.
      void 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Services singleton
// ---------------------------------------------------------------------------

export interface PIServices {
  config: PIConfig;
  sessionManager: PISessionManager;
}

const globalForPIServices = globalThis as typeof globalThis & {
  _piServices?: PIServices;
};

/** Synchronous config/services accessor (no async init needed for PI). */
export function getPIServices(): PIServices {
  if (!globalForPIServices._piServices) {
    const config = loadPIConfig();
    globalForPIServices._piServices = {
      config,
      sessionManager: createPISessionManager(config),
    };
  }
  return globalForPIServices._piServices;
}

/** Async wrapper for compatibility with code that calls `await getServices()`. */
export function getServices(): Promise<PIServices> {
  return Promise.resolve(getPIServices());
}

// ---------------------------------------------------------------------------
// Backlog — stub (returns empty; will be wired to GitHub connector later)
// ---------------------------------------------------------------------------

export interface PIBacklogIssue {
  id: string;
  title: string;
  url: string;
  labels: string[];
  projectId: string;
}

export async function getBacklogIssues(): Promise<PIBacklogIssue[]> {
  return [];
}

export async function getVerifyIssues(): Promise<PIBacklogIssue[]> {
  return [];
}

// Poller stubs (not needed for standalone PI)
export function startBacklogPoller(): void {
  void 0;
}
