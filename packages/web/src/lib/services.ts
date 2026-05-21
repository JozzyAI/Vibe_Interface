import "server-only";

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listVISessions,
  upsertVISession,
  getVIProjectBaseDir,
  type VISession,
  type VISessionStatus,
} from "@vi/core";

// ---------------------------------------------------------------------------
// PI project config
// ---------------------------------------------------------------------------

export interface VIProjectConfig {
  id: string;
  name?: string;
  path: string;
  sessionPrefix?: string;
  repo?: string;
}

export interface PIConfig {
  configPath: string;
  projects: Record<string, VIProjectConfig>;
}

function loadPIConfig(): PIConfig {
  const workspaceRoot = process.env["VI_WORKSPACE_ROOT"] ?? join(homedir(), "pi-workspace");
  const primaryProjectId = process.env["VI_PROJECT_ID"] ?? "default";
  const primaryProjectName = process.env["VI_PROJECT_NAME"] ?? "PI";

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

export interface VISessionManager {
  list: (projectId?: string) => Promise<VISession[]>;
  get: (sessionId: string) => Promise<VISession | null>;
  spawn: (input: {
    projectId: string;
    prompt?: string;
    workspacePathOverride?: string;
    issueId?: string;
  }) => Promise<VISession>;
  send: (sessionId: string, _message: string) => Promise<void>;
}

function createVISessionManager(config: PIConfig): VISessionManager {
  return {
    async list(projectId?: string): Promise<VISession[]> {
      const all = await listVISessions();
      if (!projectId || projectId === "all") return all;
      return all.filter((s) => s.projectId === projectId);
    },

    async get(sessionId: string): Promise<VISession | null> {
      const all = await listVISessions();
      return all.find((s) => s.id === sessionId) ?? null;
    },

    async spawn(input: {
      projectId: string;
      prompt?: string;
      workspacePathOverride?: string;
      issueId?: string;
    }): Promise<VISession> {
      const project = config.projects[input.projectId];
      const now = new Date().toISOString();
      const session: VISession = {
        id: `session_${randomUUID()}`,
        title: input.prompt
          ? input.prompt.split("\n")[0]?.slice(0, 80) ?? "Untitled session"
          : "Untitled session",
        projectId: input.projectId,
        issueId: input.issueId,
        status: "spawning" as VISessionStatus,
        activity: null,
        branch: null,
        pr: null,
        tool: process.env["VI_DEFAULT_AGENT"] ?? "claude-code",
        budget: { estimatedTokens: 0, estimatedUsd: 0 },
        lastUpdate: "Queued for agent",
        createdAt: now,
        updatedAt: now,
        agentInfo: null,
        metadata: {
          ...(input.prompt ? { userPrompt: input.prompt } : {}),
          ...(input.workspacePathOverride
            ? { workspacePath: input.workspacePathOverride }
            : { workspacePath: project?.path ?? getVIProjectBaseDir(input.projectId) }),
        },
      };
      await upsertVISession(session);
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
  sessionManager: VISessionManager;
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
      sessionManager: createVISessionManager(config),
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

export interface VIBacklogIssue {
  id: string;
  title: string;
  url: string;
  labels: string[];
  projectId: string;
}

export async function getBacklogIssues(): Promise<VIBacklogIssue[]> {
  return [];
}

export async function getVerifyIssues(): Promise<VIBacklogIssue[]> {
  return [];
}

// Poller stubs (not needed for standalone PI)
export function startBacklogPoller(): void {
  void 0;
}
