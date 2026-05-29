import type { Metadata } from "next";
import { VIRemoteSessionDetail, VIRemoteSessionSidePanel } from "@/components/VIRemoteSessionDetail";
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
  const [pageData, workspaceFiles] = await Promise.all([
    getDashboardPageData("all"),
    readVIWorkspaceFiles(workspaceRoot),
  ]);
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
  const sessionCount = cards.reduce(
    (total: number, card: { hub?: { fleet?: unknown[] } }) => total + (card.hub?.fleet?.length ?? 0),
    0,
  );

  return (
    <VIWorkspaceShell
      active="sessions"
      title="Live remote session"
      subtitle="Watch the remote CLI, send input, and clear detected approval prompts from the same VI workspace."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={0}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={
        <VISessionSidebar
          cards={cards}
          activeHref={`/remote-sessions/${encodeURIComponent(params.id)}`}
        />
      }
      sidebarFooter={`${sessionCount} session${sessionCount === 1 ? "" : "s"} shown`}
      rightSidebarTitle="Session"
      rightSidebarContent={
        <VIRemoteSessionSidePanel jobId={params.id} initialOverview={EMPTY_OVERVIEW} />
      }
      hideHeader
    >
      <VIRemoteSessionDetail jobId={params.id} initialOverview={EMPTY_OVERVIEW} />
    </VIWorkspaceShell>
  );
}
