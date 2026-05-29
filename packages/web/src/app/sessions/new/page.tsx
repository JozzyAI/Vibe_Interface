import type { Metadata } from "next";
import { VISessionCreator } from "@/components/VISessionCreator";
import { VISessionSidebar } from "@/components/VISessionSidebar";
import { VIWorkspaceShell } from "@/components/VIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getVIApprovalHubData } from "@/lib/vi-approval-hub";
import { getVIIdeaExecutionRoot } from "@/lib/vi-ideas";
import { readVIWorkspaceFiles } from "@/lib/vi-workspace-files";
import type { RemoteApprovalOverview } from "@/lib/types";

const EMPTY_OVERVIEW: RemoteApprovalOverview = {
  generatedAt: "",
  stats: { agents: 0, running: 0, pending: 0, failed: 0 },
  agents: [], requests: [], jobs: [], events: [], enrollments: [], recentEnrollments: [],
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    absolute: "VI | Add Session",
  },
};

export default async function AddSessionPage() {
  const pageData = await getDashboardPageData("all");
  const cards = await Promise.all(
    pageData.projects.map(async (project: { id: string; name: string; sessionPrefix?: string }) => {
      const projectPageData = await getDashboardPageData(project.id);
      return {
        projectId: project.id,
        projectName: project.name,
        hub: await getVIApprovalHubData({
          projectId: project.id,
          sessions: projectPageData.sessions,
          controlPlane: projectPageData.controlPlane,
        }),
      };
    }),
  );
  const workspaceRoot = getVIIdeaExecutionRoot();
  const workspaceFiles = await readVIWorkspaceFiles(workspaceRoot);
  const sessionCount = cards.reduce(
    (total: number, card: { hub?: { fleet?: unknown[] } }) => total + (card.hub?.fleet?.length ?? 0),
    0,
  );

  return (
    <VIWorkspaceShell
      active="sessions"
      title="Add session"
      subtitle="Start a new coding-agent session on any connected machine."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={0}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={
        <VISessionSidebar cards={cards} activeHref="/sessions/new" />
      }
      sidebarFooter={`${sessionCount} session${sessionCount === 1 ? "" : "s"} shown`}
    >
      <VISessionCreator
        initialRemoteOverview={EMPTY_OVERVIEW}
        workspaceRoot={workspaceRoot}
        claudeDefaultModel={process.env["VI_CLAUDE_DEFAULT_MODEL"]?.trim() || undefined}
      />
    </VIWorkspaceShell>
  );
}
