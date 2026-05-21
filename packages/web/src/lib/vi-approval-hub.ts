import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getProjectBaseDir } from "@vi/core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  DashboardSession,

  VIApprovalAuditEntry,
  VIApprovalEventType,
  VIApprovalFleetItem,
  VIApprovalHubData,
  VIApprovalInboxEntry,
  VIApprovalPrimaryAction,
  VIApprovalPermissionMode,
  VIApprovalPolicySummary,
  VIApprovalRiskLevel,
  VIControlPlaneData,
} from "@/lib/types";
import { getSessionTitle } from "@/lib/format";
import { parseNativeCodexApproval } from "@/lib/native-codex-approval";
import { getServices } from "@/lib/services";

interface VIApprovalPolicyRecord {
  mode: VIApprovalPermissionMode;
  timeoutSeconds: number;
  updatedAt: string;
}

interface VIApprovalHubStore {
  projectPolicy: VIApprovalPolicyRecord;
  sessionPolicies: Record<string, VIApprovalPolicyRecord>;
  audit: VIApprovalAuditEntry[];
}

const DEFAULT_TIMEOUT_SECONDS = 10;

function approvalHubDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "pi-approval-hub");
}

function approvalHubStatePath(configPath: string, projectPath: string): string {
  return join(approvalHubDir(configPath, projectPath), "state.json");
}

function defaultStore(): VIApprovalHubStore {
  const now = new Date().toISOString();
  return {
    projectPolicy: {
      mode: "manual",
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      updatedAt: now,
    },
    sessionPolicies: {},
    audit: [],
  };
}

async function readStore(configPath: string, projectPath: string): Promise<VIApprovalHubStore> {
  try {
    const raw = await readFile(approvalHubStatePath(configPath, projectPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<VIApprovalHubStore>;
    const fallback = defaultStore();
    return {
      projectPolicy: {
        mode:
          parsed.projectPolicy?.mode === "timeout_allow" ||
          parsed.projectPolicy?.mode === "always_allow" ||
          parsed.projectPolicy?.mode === "manual"
            ? parsed.projectPolicy.mode
            : fallback.projectPolicy.mode,
        timeoutSeconds:
          typeof parsed.projectPolicy?.timeoutSeconds === "number" &&
          parsed.projectPolicy.timeoutSeconds > 0
            ? parsed.projectPolicy.timeoutSeconds
            : fallback.projectPolicy.timeoutSeconds,
        updatedAt:
          typeof parsed.projectPolicy?.updatedAt === "string"
            ? parsed.projectPolicy.updatedAt
            : fallback.projectPolicy.updatedAt,
      },
      sessionPolicies:
        parsed.sessionPolicies && typeof parsed.sessionPolicies === "object"
          ? Object.fromEntries(
              Object.entries(parsed.sessionPolicies).flatMap(([sessionId, policy]) => {
                if (!policy || typeof policy !== "object") return [];
                const mode =
                  policy.mode === "manual" ||
                  policy.mode === "timeout_allow" ||
                  policy.mode === "always_allow"
                    ? policy.mode
                    : null;
                if (!mode) return [];
                return [[
                  sessionId,
                  {
                    mode,
                    timeoutSeconds:
                      typeof policy.timeoutSeconds === "number" && policy.timeoutSeconds > 0
                        ? policy.timeoutSeconds
                        : DEFAULT_TIMEOUT_SECONDS,
                    updatedAt:
                      typeof policy.updatedAt === "string" ? policy.updatedAt : fallback.projectPolicy.updatedAt,
                  },
                ]];
              }),
            )
          : {},
      audit: Array.isArray(parsed.audit)
        ? parsed.audit.filter(
            (entry): entry is VIApprovalAuditEntry =>
              Boolean(
                entry &&
                  typeof entry.id === "string" &&
                  typeof entry.createdAt === "string" &&
                  typeof entry.actorLabel === "string" &&
                  typeof entry.eventType === "string" &&
                  typeof entry.title === "string" &&
                  typeof entry.details === "string",
              ),
          )
        : [],
    };
  } catch {
    return defaultStore();
  }
}

async function writeStore(configPath: string, projectPath: string, store: VIApprovalHubStore): Promise<void> {
  await mkdir(approvalHubDir(configPath, projectPath), { recursive: true });
  await writeFile(approvalHubStatePath(configPath, projectPath), JSON.stringify(store, null, 2), "utf8");
}

function summarizeSession(session: DashboardSession): string | null {
  return session.summary ?? session.userPrompt ?? session.issueTitle ?? null;
}

function normalizePolicy(
  policy: VIApprovalPolicyRecord | undefined,
  fallback: VIApprovalPolicyRecord,
): VIApprovalPolicyRecord {
  return policy
    ? {
        mode: policy.mode,
        timeoutSeconds: policy.timeoutSeconds,
        updatedAt: policy.updatedAt,
      }
    : fallback;
}

export async function getVIApprovalPolicy(input: {
  projectId: string;
  sessionId?: string;
}): Promise<VIApprovalPolicySummary> {
  const { config } = await getServices();
  const project = config.projects[input.projectId];
  if (!project) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }
  const store = await readStore(config.configPath, project.path);
  const policy = normalizePolicy(
    input.sessionId ? store.sessionPolicies[input.sessionId] : undefined,
    store.projectPolicy,
  );
  return {
    scopeType: input.sessionId ? "session" : "project",
    scopeId: input.sessionId ?? input.projectId,
    label: input.sessionId ?? "Project default",
    mode: policy.mode,
    timeoutSeconds: policy.timeoutSeconds,
    updatedAt: policy.updatedAt,
  };
}

function inboxRisk(kind: VIApprovalInboxEntry["kind"]): VIApprovalRiskLevel {
  switch (kind) {
    case "final_approval":
      return "high";
    case "plan_approval":
      return "medium";
    case "scope_clarification":
      return "low";
    case "example_request":
      return "low";
    default:
      return "medium";
  }
}

function inboxActionLabel(kind: VIApprovalInboxEntry["kind"]): string {
  switch (kind) {
    case "final_approval":
      return "High-impact approval";
    case "plan_approval":
      return "Plan approval";
    case "scope_clarification":
      return "Needs clarification";
    case "example_request":
      return "Needs example";
    default:
      return "Agent request";
  }
}

function requestEventType(kind: VIApprovalInboxEntry["kind"]): VIApprovalEventType {
  switch (kind) {
    case "final_approval":
      return "final_approval";
    case "plan_approval":
      return "plan_approval";
    case "scope_clarification":
      return "scope_clarification";
    case "example_request":
      return "example_request";
    default:
      return "generic";
  }
}

function requestPrimaryAction(kind: VIApprovalInboxEntry["kind"]): VIApprovalPrimaryAction {
  switch (kind) {
    case "scope_clarification":
    case "example_request":
      return "reply";
    default:
      return "approve";
  }
}

function classifyNativeCommand(command: string | null | undefined): VIApprovalEventType {
  const normalized = command?.trim().toLowerCase() ?? "";
  if (!normalized) return "command";
  if (
    normalized.startsWith("wget ") ||
    normalized.startsWith("curl ") ||
    normalized.includes(" http://") ||
    normalized.includes(" https://")
  ) {
    return "network_access";
  }
  if (
    normalized.startsWith("npm install") ||
    normalized.startsWith("pnpm add") ||
    normalized.startsWith("yarn add") ||
    normalized.startsWith("pip install") ||
    normalized.startsWith("uv pip install") ||
    normalized.startsWith("brew install") ||
    normalized.startsWith("apt install") ||
    normalized.startsWith("apt-get install") ||
    normalized.startsWith("docker pull")
  ) {
    return "dependency_install";
  }
  if (normalized.startsWith("git push")) return "git_push";
  if (
    normalized.startsWith("rm ") ||
    normalized.startsWith("rm -") ||
    normalized.startsWith("del ") ||
    normalized.startsWith("rmdir ") ||
    normalized.startsWith("remove-item ")
  ) {
    return "delete_operation";
  }
  return "command";
}

function nativeActionLabel(eventType: VIApprovalEventType): string {
  switch (eventType) {
    case "network_access":
      return "Network access";
    case "dependency_install":
      return "Dependency install";
    case "git_push":
      return "Git push";
    case "delete_operation":
      return "Delete operation";
    default:
      return "Command approval";
  }
}

function nativeRisk(eventType: VIApprovalEventType): VIApprovalRiskLevel {
  switch (eventType) {
    case "git_push":
    case "delete_operation":
      return "high";
    case "network_access":
    case "dependency_install":
      return "medium";
    default:
      return "medium";
  }
}

function isBootstrapApproval(requestId: string): boolean {
  return requestId.startsWith("pi_bootstrap_");
}

function fleetRisk(session: DashboardSession, pendingCount: number): VIApprovalRiskLevel {
  if (pendingCount > 0 && session.piState === "awaiting_approval") return "high";
  if (pendingCount > 0) return "medium";
  if (session.piState === "failed") return "high";
  return "low";
}

async function loadNativeApprovalBySession(
  sessions: DashboardSession[],
): Promise<Map<string, ReturnType<typeof parseNativeCodexApproval>>> {
  const entries = await Promise.all(
    sessions.map(async (session) => {
      const tmuxName = session.metadata["tmuxName"] ?? session.metadata["host"] ?? session.id;
      const output = "";
      return [session.id, parseNativeCodexApproval(output)] as const;
    }),
  );
  return new Map(entries.filter((entry) => entry[1]));
}

export async function appendVIApprovalAuditEvent(
  configPath: string,
  projectPath: string,
  entry: Omit<VIApprovalAuditEntry, "id" | "createdAt"> & { createdAt?: string },
): Promise<VIApprovalAuditEntry> {
  const store = await readStore(configPath, projectPath);
  const auditEntry: VIApprovalAuditEntry = {
    id: `pia_${randomUUID()}`,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    actorLabel: entry.actorLabel,
    eventType: entry.eventType,
    title: entry.title,
    details: entry.details,
    sessionId: entry.sessionId,
    requestId: entry.requestId,
  };
  store.audit = [auditEntry, ...store.audit].slice(0, 200);
  await writeStore(configPath, projectPath, store);
  return auditEntry;
}

export async function setVIApprovalPolicy(input: {
  projectId: string;
  sessionId?: string;
  mode: VIApprovalPermissionMode;
  timeoutSeconds?: number;
}): Promise<void> {
  const { config } = await getServices();
  const project = config.projects[input.projectId];
  if (!project) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }
  const timeoutSeconds =
    typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0
      ? Math.floor(input.timeoutSeconds)
      : DEFAULT_TIMEOUT_SECONDS;
  const store = await readStore(config.configPath, project.path);
  const updatedAt = new Date().toISOString();
  const nextPolicy: VIApprovalPolicyRecord = {
    mode: input.mode,
    timeoutSeconds,
    updatedAt,
  };

  if (input.sessionId) {
    store.sessionPolicies[input.sessionId] = nextPolicy;
  } else {
    store.projectPolicy = nextPolicy;
  }

  await writeStore(config.configPath, project.path, store);
  await appendVIApprovalAuditEvent(config.configPath, project.path, {
    actorLabel: "VI dashboard",
    eventType: "policy_changed",
    title: input.sessionId ? "Session permission mode changed" : "Project permission mode changed",
    details: input.sessionId
      ? `${input.sessionId} -> ${input.mode} (${timeoutSeconds}s)`
      : `${input.projectId} default -> ${input.mode} (${timeoutSeconds}s)`,
    sessionId: input.sessionId,
  });
}

export async function getVIApprovalHubData(input: {
  projectId: string;
  sessions: DashboardSession[];
  controlPlane: VIControlPlaneData;
}): Promise<VIApprovalHubData> {
  const { config } = await getServices();
  const project = config.projects[input.projectId];
  if (!project) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }

  const store = await readStore(config.configPath, project.path);
  const nativeApprovals = await loadNativeApprovalBySession(input.sessions);
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  const visibleInboxItems = input.controlPlane.inbox.filter(
    (item) => !isBootstrapApproval(item.requestId),
  );
  const inboxCounts = new Map<string, number>();
  for (const item of visibleInboxItems) {
    inboxCounts.set(item.sessionId, (inboxCounts.get(item.sessionId) ?? 0) + 1);
  }
  for (const sessionId of nativeApprovals.keys()) {
    inboxCounts.set(sessionId, (inboxCounts.get(sessionId) ?? 0) + 1);
  }

  const projectPolicy: VIApprovalPolicySummary = {
    scopeType: "project",
    scopeId: input.projectId,
    label: "Project default",
    mode: store.projectPolicy.mode,
    timeoutSeconds: store.projectPolicy.timeoutSeconds,
    updatedAt: store.projectPolicy.updatedAt,
  };

  const fleet: VIApprovalFleetItem[] = input.sessions.map((session) => {
    const policy = normalizePolicy(store.sessionPolicies[session.id], store.projectPolicy);
    const pendingApprovalCount = inboxCounts.get(session.id) ?? 0;
    return {
      sessionId: session.id,
      projectId: session.projectId,
      sessionTitle: getSessionTitle(session),
      status: session.status,
      piState: session.piState,
      toolType: session.metadata["agent"] ?? "unknown",
      hostLabel: session.metadata["tmuxName"] ?? "current-host",
      repoRoot: session.metadata["repoRoot"],
      branch: session.branch ?? undefined,
      worktree: session.metadata["worktree"],
      summary: summarizeSession(session),
      permissionMode: policy.mode,
      timeoutSeconds: policy.timeoutSeconds,
      pendingApprovalCount,
      riskLevel: fleetRisk(session, pendingApprovalCount),
      lastActivityAt: session.lastActivityAt,
    };
  });

  const inbox: VIApprovalInboxEntry[] = visibleInboxItems.map((item) => {
    const policy = normalizePolicy(store.sessionPolicies[item.sessionId], store.projectPolicy);
    const session = sessionById.get(item.sessionId);
    return {
      ...item,
      actionLabel: inboxActionLabel(item.kind),
      riskLevel: inboxRisk(item.kind),
      permissionMode: policy.mode,
      timeoutSeconds: policy.timeoutSeconds,
      sourceType: "pi_request",
      context: {
        eventType: requestEventType(item.kind),
        primaryAction: requestPrimaryAction(item.kind),
        toolType: session?.metadata["agent"] ?? null,
        repoRoot: session?.metadata["repoRoot"] ?? null,
        worktree: session?.metadata["worktree"] ?? null,
        branch: session?.branch ?? null,
        sourceLabel: session ? getSessionTitle(session) : item.sessionTitle,
      },
    };
  });

  const nativeInbox: VIApprovalInboxEntry[] = input.sessions.flatMap((session) => {
    const approval = nativeApprovals.get(session.id);
    if (!approval) return [];
    const policy = normalizePolicy(store.sessionPolicies[session.id], store.projectPolicy);
    const timestamp = session.lastActivityAt || new Date().toISOString();
    const eventType = classifyNativeCommand(approval.command);
    return [
      {
        requestId: `native:${session.id}`,
        sessionId: session.id,
        projectId: input.projectId,
        sessionTitle: getSessionTitle(session),
        kind: "plan_approval",
        status: "open",
        title: approval.title,
        message:
          approval.reason ??
          (approval.command
            ? `Codex CLI is waiting for approval to run: ${approval.command}`
            : "Codex CLI is waiting for command approval."),
        createdAt: timestamp,
        updatedAt: timestamp,
        actionLabel: nativeActionLabel(eventType),
        riskLevel: nativeRisk(eventType),
        permissionMode: policy.mode,
        timeoutSeconds: policy.timeoutSeconds,
        sourceType: "native_command",
        nativeCommand: approval.command,
        context: {
          eventType,
          primaryAction: "approve",
          command: approval.command,
          toolType: session.metadata["agent"] ?? "codex",
          repoRoot: session.metadata["repoRoot"] ?? null,
          worktree: session.metadata["worktree"] ?? null,
          branch: session.branch ?? null,
          sourceLabel: "Codex CLI",
        },
      },
    ];
  });

  const mergedInbox = [...nativeInbox, ...inbox].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );

  const policies: VIApprovalPolicySummary[] = [
    projectPolicy,
    ...fleet.map((item) => ({
      scopeType: "session" as const,
      scopeId: item.sessionId,
      label: item.sessionTitle,
      mode: item.permissionMode,
      timeoutSeconds: item.timeoutSeconds,
      updatedAt: store.sessionPolicies[item.sessionId]?.updatedAt ?? store.projectPolicy.updatedAt,
    })),
  ];

  const stats = {
    agents: fleet.length,
    running: fleet.filter((item) => item.status === "working").length,
    awaitingApproval: fleet.filter((item) => item.piState === "awaiting_approval").length,
    awaitingInput: fleet.filter((item) => item.piState === "awaiting_user_input").length,
    failed: fleet.filter((item) => item.piState === "failed" || item.status === "killed").length,
    completed: fleet.filter((item) => item.status === "merged" || item.status === "done").length,
    inbox: mergedInbox.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    projectId: input.projectId,
    stats,
    projectPolicy,
    fleet,
    inbox: mergedInbox,
    recovery: input.controlPlane.recovery,
    policies,
    history: [...store.audit].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 40),
  };
}
