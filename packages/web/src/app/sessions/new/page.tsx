import type { Metadata } from "next";
import { VISessionCreator } from "@/components/VISessionCreator";
import { getVISessionSidebarCount, VISessionSidebar } from "@/components/VISessionSidebar";
import { VIWorkspaceShell } from "@/components/VIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getVIApprovalHubData } from "@/lib/vi-approval-hub";
import { getVIIdeaExecutionRoot } from "@/lib/vi-ideas";
import { readVIWorkspaceFiles } from "@/lib/vi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/backend";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    absolute: "PI | Add Session",
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
  const [remoteOverview, workspaceFiles] = await Promise.all([
    getRemoteApprovalOverview(),
    readVIWorkspaceFiles(workspaceRoot),
  ]);
  const connectedCount = remoteOverview.agents.filter(
    (agent) => agent.connectionState === "connected",
  ).length;
  const sessionCount = getVISessionSidebarCount(cards, remoteOverview);

  return (
    <VIWorkspaceShell
      active="sessions"
      title="Add session"
      subtitle="Start a new coding-agent session on any connected machine."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={
        <VISessionSidebar
          cards={cards}
          remoteOverview={remoteOverview}
          activeHref="/sessions/new"
        />
      }
      sidebarFooter={`${sessionCount} session${sessionCount === 1 ? "" : "s"} shown`}
    >
      <VISessionCreator
        initialRemoteOverview={remoteOverview}
        workspaceRoot={workspaceRoot}
        claudeDefaultModel={process.env["VI_CLAUDE_DEFAULT_MODEL"]?.trim() || undefined}
      />
    </VIWorkspaceShell>
  );
}
