import type { Metadata } from "next";
import { VIRemoteSessionDetail, VIRemoteSessionSidePanel } from "@/components/VIRemoteSessionDetail";
import { getVISessionSidebarCount, VISessionSidebar } from "@/components/VISessionSidebar";
import { VIWorkspaceShell } from "@/components/VIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getVIApprovalHubData } from "@/lib/vi-approval-hub";
import { getVIIdeaExecutionRoot } from "@/lib/vi-ideas";
import { readVIWorkspaceFiles } from "@/lib/vi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  return {
    title: {
      absolute: `VI | Remote Session ${params.id.slice(0, 8)}`,
    },
  };
}

export default async function RemoteSessionPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const workspaceRoot = getVIIdeaExecutionRoot();
  const ssr0 = Date.now();
  const [pageData, remoteOverview, workspaceFiles] = await Promise.all([
    getDashboardPageData("all"),
    getRemoteApprovalOverview(),
    readVIWorkspaceFiles(workspaceRoot),
  ]);
  console.log(`[remote-session-ssr] parallel fetch done in ${Date.now() - ssr0}ms (projects=${pageData.projects.length})`);
  const cards0 = Date.now();
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
  console.log(`[remote-session-ssr] per-project fan-out done in ${Date.now() - cards0}ms total=${Date.now() - ssr0}ms`);
  const connectedCount = remoteOverview.agents.filter(
    (agent) => agent.connectionState === "connected",
  ).length;
  const sessionCount = getVISessionSidebarCount(cards, remoteOverview);

  return (
    <VIWorkspaceShell
      active="sessions"
      title="Live remote session"
      subtitle="Watch the remote CLI, send input, and clear detected approval prompts from the same VI workspace."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={
        <VISessionSidebar
          cards={cards}
          remoteOverview={remoteOverview}
          activeHref={`/remote-sessions/${encodeURIComponent(params.id)}`}
        />
      }
      sidebarFooter={`${sessionCount} session${sessionCount === 1 ? "" : "s"} shown`}
      rightSidebarTitle="Session"
      rightSidebarContent={
        <VIRemoteSessionSidePanel jobId={params.id} initialOverview={remoteOverview} />
      }
      hideHeader
    >
      <VIRemoteSessionDetail jobId={params.id} initialOverview={remoteOverview} />
    </VIWorkspaceShell>
  );
}
