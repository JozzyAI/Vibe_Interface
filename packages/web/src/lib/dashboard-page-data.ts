import "server-only";

import { cache } from "react";
import { listPISessions, type PISession } from "@pi/core";
import {
  TERMINAL_STATUSES,
  type DashboardSession,
  type DashboardOrchestratorLink,
  type PIControlPlaneData,
  type PIIdeaBoardData,
} from "@/lib/types";
import { getServices } from "@/lib/services";
import { getPrimaryProjectId, getProjectName, getAllProjects, type ProjectInfo } from "@/lib/project-name";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";
import { getPIControlPlaneData } from "@/lib/pi-control-plane";
import { getPIIdeaBoard } from "@/lib/pi-ideas";
import { derivePISessionState } from "@pi/core";

export interface DashboardPageData {
  sessions: DashboardSession[];
  orchestrators: DashboardOrchestratorLink[];
  projectName: string;
  projects: ProjectInfo[];
  selectedProjectId?: string;
  controlPlane: PIControlPlaneData;
  ideaBoard?: PIIdeaBoardData;
}

function piSessionToDashboard(session: PISession): DashboardSession {
  const pr = session.pr
    ? {
        number: session.pr.number,
        url: session.pr.url,
        title: "",
        owner: "",
        repo: "",
        branch: session.branch ?? "",
        baseBranch: "main",
        isDraft: false,
        state: "open" as const,
        additions: 0,
        deletions: 0,
        ciStatus: "pending" as const,
        ciChecks: [],
        reviewDecision: "pending" as const,
        mergeability: { mergeable: false, ciPassing: false, approved: false, noConflicts: true, blockers: [] },
        unresolvedThreads: 0,
        unresolvedComments: [],
        enriched: false,
      }
    : null;

  const summary = session.agentInfo?.summary
    ?? session.metadata["summary"]
    ?? session.metadata["pinnedSummary"]
    ?? session.lastUpdate
    ?? null;

  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    piState: derivePISessionState(session),
    activity: session.activity,
    branch: session.branch ?? null,
    issueId: session.issueId ?? null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: session.title ?? null,
    userPrompt: session.metadata["userPrompt"] ?? null,
    summary,
    summaryIsFallback: !session.agentInfo?.summary,
    createdAt: session.createdAt,
    lastActivityAt: session.updatedAt,
    pr,
    metadata: session.metadata,
  };
}

export const getDashboardProjectName = cache(function getDashboardProjectName(
  projectFilter: string | undefined,
): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selected = projects.find((p: ProjectInfo) => p.id === projectFilter);
    if (selected) return selected.name;
  }
  return getProjectName();
});

export function resolveDashboardProjectFilter(project?: string): string {
  if (project === "all") return "all";
  const projects = getAllProjects();
  if (project && projects.some((p: ProjectInfo) => p.id === project)) return project;
  return getPrimaryProjectId();
}

const EMPTY_CONTROL_PLANE: PIControlPlaneData = {
  generatedAt: new Date().toISOString(),
  counts: { inbox: 0, recovery: 0, backlog: 0 },
  github: { available: false, selectedConnectorId: null, connectors: [] },
  inbox: [],
  recovery: [],
  backlog: [],
};

export const getDashboardPageData = cache(async function getDashboardPageData(
  project?: string,
): Promise<DashboardPageData> {
  const projectFilter = resolveDashboardProjectFilter(project);
  const { config } = await getServices();

  const pageData: DashboardPageData = {
    sessions: [],
    orchestrators: [],
    projectName: getDashboardProjectName(projectFilter),
    projects: getAllProjects(),
    selectedProjectId: projectFilter === "all" ? undefined : projectFilter,
    controlPlane: EMPTY_CONTROL_PLANE,
    ideaBoard: undefined,
  };

  try {
    const allSessions = await listPISessions();
    const workerSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);
    pageData.sessions = workerSessions.map(piSessionToDashboard);
  } catch {
    void 0;
  }

  try {
    pageData.controlPlane = await getPIControlPlaneData(projectFilter);
  } catch {
    void 0;
  }

  try {
    const primaryProjectId = projectFilter !== "all" ? projectFilter : getPrimaryProjectId();
    if (primaryProjectId && config.projects[primaryProjectId]) {
      pageData.ideaBoard = await getPIIdeaBoard(primaryProjectId);
    }
  } catch {
    void 0;
  }

  return pageData;
});
