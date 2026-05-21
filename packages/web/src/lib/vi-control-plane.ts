import "server-only";

import {
  deriveVISessionState,
  isVISessionRestorable,
  listVIGitHubConnectors,
  readVISessionArtifacts,
  type PIPendingQuestion,
  type VISession,
} from "@vi/core";
import type {
  VIBacklogItem,
  VIControlPlaneData,
  VIGitHubConnectorSummary,
  VIInboxItem,
  VIRecoveryItem,
} from "@/lib/types";
import { getBacklogIssues, getServices } from "@/lib/services";
import { filterWorkerSessions } from "@/lib/project-utils";

function summarizeSession(session: VISession): string {
  return (
    session.agentInfo?.summary ??
    session.metadata["summary"] ??
    session.metadata["pinnedSummary"] ??
    session.metadata["userPrompt"] ??
    session.issueId ??
    session.id
  );
}

function fallbackInboxItem(session: VISession, question?: PIPendingQuestion): VIInboxItem {
  const piState = deriveVISessionState(session, question ? [question] : []);
  const genericKind = piState === "awaiting_approval" ? "plan_approval" : "scope_clarification";

  return {
    requestId: question?.id ?? `${session.id}:fallback`,
    sessionId: session.id,
    projectId: session.projectId,
    sessionTitle: summarizeSession(session),
    kind: question?.kind ?? genericKind,
    status: question?.status ?? "open",
    title:
      question?.title ??
      (piState === "awaiting_approval" ? "Approval needed" : "Agent is waiting for input"),
    message:
      question?.message ??
      (piState === "awaiting_approval"
        ? "This session is paused for a scope or plan approval."
        : "This session is waiting for clarification, an example, or another human reply."),
    createdAt: question?.createdAt ?? session.updatedAt,
    updatedAt: question?.updatedAt ?? session.updatedAt,
    response: question?.response,
  };
}

function toRecoveryItem(
  session: VISession,
  summary: string | null,
  piState = deriveVISessionState(session),
): VIRecoveryItem {
  return {
    sessionId: session.id,
    projectId: session.projectId,
    sessionTitle: summarizeSession(session),
    piState,
    aoStatus: session.status,
    lastActivityAt: session.updatedAt,
    summary: summary ? summary.split("\n").slice(0, 6).join("\n") : null,
    restoreAvailable: isVISessionRestorable(session),
  };
}

function toBacklogItem(issue: {
  id: string;
  title: string;
  url: string;
  labels: string[];
  projectId: string;
}): VIBacklogItem {
  return {
    projectId: issue.projectId,
    issueId: issue.id,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
  };
}

function toGitHubConnectorSummary(
  connector: Awaited<ReturnType<typeof listVIGitHubConnectors>>["connectors"][number],
  selectedConnectorId: string | null,
): VIGitHubConnectorSummary {
  return {
    id: connector.id,
    label: connector.label,
    host: connector.host,
    accountLogin: connector.accountLogin,
    owner: connector.owner,
    repo: connector.repo,
    authType: connector.authType,
    tokenPreview: connector.tokenPreview,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    isSelected: connector.id === selectedConnectorId,
  };
}

export async function getVIControlPlaneData(projectFilter?: string): Promise<VIControlPlaneData> {
  const { config, sessionManager } = await getServices();
  const allSessions = await sessionManager.list();
  const workerSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);

  const inbox: VIInboxItem[] = [];
  const recovery: VIRecoveryItem[] = [];

  await Promise.all(
    workerSessions.map(async (session) => {
      const project = config.projects[session.projectId];
      if (!project) return;

      const artifacts = await readVISessionArtifacts(config.configPath, project.path, session.id);
      const piState = deriveVISessionState(session, artifacts.pendingQuestions);
      const openQuestions = artifacts.pendingQuestions.filter((question) => question.status === "open");

      if (openQuestions.length > 0) {
        for (const question of openQuestions) {
          inbox.push(fallbackInboxItem(session, question));
        }
      } else if (piState === "awaiting_user_input" || piState === "awaiting_approval") {
        inbox.push(fallbackInboxItem(session));
      }

      if (
        isVISessionRestorable(session) ||
        piState === "blocked" ||
        piState === "failed"
      ) {
        recovery.push(toRecoveryItem(session, artifacts.summary, piState));
      }
    }),
  );

  const backlogIssues = (await getBacklogIssues())
    .filter((issue) => !projectFilter || projectFilter === "all" || issue.projectId === projectFilter)
    .map(toBacklogItem);

  const github =
    projectFilter && projectFilter !== "all" && config.projects[projectFilter]
      ? await listVIGitHubConnectors(config.configPath, config.projects[projectFilter].path)
      : { selectedConnectorId: null, connectors: [] };

  inbox.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  recovery.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));

  return {
    generatedAt: new Date().toISOString(),
    projectId: !projectFilter || projectFilter === "all" ? undefined : projectFilter,
    counts: {
      inbox: inbox.length,
      recovery: recovery.length,
      backlog: backlogIssues.length,
    },
    github: {
      available: Boolean(projectFilter && projectFilter !== "all" && config.projects[projectFilter]),
      projectId: !projectFilter || projectFilter === "all" ? undefined : projectFilter,
      selectedConnectorId: github.selectedConnectorId,
      connectors: github.connectors.map((connector) =>
        toGitHubConnectorSummary(connector, github.selectedConnectorId),
      ),
    },
    inbox,
    recovery,
    backlog: backlogIssues,
  };
}
