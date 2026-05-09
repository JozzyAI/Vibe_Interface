import type { Metadata } from "next";
import { PIRemoteSessionDetail, PIRemoteSessionSidePanel } from "@/components/PIRemoteSessionDetail";
import { getPISessionSidebarCount, PISessionSidebar } from "@/components/PISessionSidebar";
import { PIWorkspaceShell } from "@/components/PIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getPIApprovalHubData } from "@/lib/pi-approval-hub";
import { getPIIdeaExecutionRoot } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  return {
    title: {
      absolute: `PI | Remote Session ${params.id.slice(0, 8)}`,
    },
  };
}

export default async function RemoteSessionPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const workspaceRoot = getPIIdeaExecutionRoot();
  const [pageData, remoteOverview, workspaceFiles] = await Promise.all([
    getDashboardPageData("all"),
    getRemoteApprovalOverview(),
    readPIWorkspaceFiles(workspaceRoot),
  ]);
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
  const connectedCount = remoteOverview.agents.filter(
    (agent) => agent.connectionState === "connected",
  ).length;
  const sessionCount = getPISessionSidebarCount(cards, remoteOverview);

  return (
    <PIWorkspaceShell
      active="sessions"
      title="Live remote session"
      subtitle="Watch the remote CLI, send input, and clear detected approval prompts from the same PI workspace."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={
        <PISessionSidebar
          cards={cards}
          remoteOverview={remoteOverview}
          activeHref={`/remote-sessions/${encodeURIComponent(params.id)}`}
        />
      }
      sidebarFooter={`${sessionCount} session${sessionCount === 1 ? "" : "s"} shown`}
      rightSidebarTitle="Session"
      rightSidebarContent={
        <PIRemoteSessionSidePanel jobId={params.id} initialOverview={remoteOverview} />
      }
      hideHeader
    >
      <PIRemoteSessionDetail jobId={params.id} initialOverview={remoteOverview} />
    </PIWorkspaceShell>
  );
}
