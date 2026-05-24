import type { Metadata } from "next";
import { VIIdeaBoard } from "@/components/VIIdeaBoard";
import { VIWorkspaceShell } from "@/components/VIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getVIIdeaBoard, getVIIdeaExecutionRoot, resolveVIIdeaProjectId } from "@/lib/vi-ideas";
import { readVIWorkspaceFiles } from "@/lib/vi-workspace-files";
import { getAllProjects } from "@/lib/project-name";
import { getRemoteApprovalOverview } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectId = await resolveVIIdeaProjectId(searchParams.project);
  const project = getAllProjects().find((entry: { id: string; name?: string }) => entry.id === projectId);
  return {
    title: {
      absolute: `VI | ${project?.name ?? projectId ?? "Drafts"} - Drafts`,
    },
  };
}

export default async function IdeasPage(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const searchParams = await props.searchParams;
  const projectId = await resolveVIIdeaProjectId(searchParams.project);
  const board = await getVIIdeaBoard(projectId);
  const executionRoot = getVIIdeaExecutionRoot();
  const [pageData, remoteOverview, workspaceFiles] = await Promise.all([
    getDashboardPageData("all"),
    getRemoteApprovalOverview(),
    readVIWorkspaceFiles(executionRoot),
  ]);
  const connectedCount = remoteOverview.agents.filter(
    (agent: { connectionState: string }) => agent.connectionState === "connected",
  ).length;

  return (
    <VIWorkspaceShell
      active="drafts"
      title="Draft reusable task specs"
      subtitle={`Save markdown task drafts, then send them to a connected agent. Project folders are created under ${executionRoot}.`}
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={executionRoot}
      workspaceFiles={workspaceFiles}
    >
      <VIIdeaBoard
        initialData={board}
        initialRemoteOverview={remoteOverview}
        projectId={projectId}
        executionRoot={executionRoot}
        mode="full"
      />
    </VIWorkspaceShell>
  );
}
