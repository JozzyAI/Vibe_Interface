import type { Metadata } from "next";
import { PISessionCreator } from "@/components/PISessionCreator";
import { getPISessionSidebarCount, PISessionSidebar } from "@/components/PISessionSidebar";
import { PIWorkspaceShell } from "@/components/PIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getPIApprovalHubData } from "@/lib/pi-approval-hub";
import { getPIIdeaExecutionRoot } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

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
        hub: await getPIApprovalHubData({
          projectId: project.id,
          sessions: projectPageData.sessions,
          controlPlane: projectPageData.controlPlane,
        }),
      };
    }),
  );
  const workspaceRoot = getPIIdeaExecutionRoot();
  const [remoteOverview, workspaceFiles] = await Promise.all([
    getRemoteApprovalOverview(),
    readPIWorkspaceFiles(workspaceRoot),
  ]);
  const connectedCount = remoteOverview.agents.filter(
    (agent) => agent.connectionState === "connected",
  ).length;
  const sessionCount = getPISessionSidebarCount(cards, remoteOverview);

  return (
    <PIWorkspaceShell
      active="sessions"
      title="Add session"
      subtitle="Start a new coding-agent session on any connected machine."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={
        <PISessionSidebar
          cards={cards}
          remoteOverview={remoteOverview}
          activeHref="/sessions/new"
        />
      }
      sidebarFooter={`${sessionCount} session${sessionCount === 1 ? "" : "s"} shown`}
    >
      <PISessionCreator initialRemoteOverview={remoteOverview} workspaceRoot={workspaceRoot} />
    </PIWorkspaceShell>
  );
}
