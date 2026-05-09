import type { Metadata } from "next";
import { PIIdeaBoard } from "@/components/PIIdeaBoard";
import { PIWorkspaceShell } from "@/components/PIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getPIIdeaBoard, getPIIdeaExecutionRoot, resolvePIIdeaProjectId } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getAllProjects } from "@/lib/project-name";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectId = await resolvePIIdeaProjectId(searchParams.project);
  const project = getAllProjects().find((entry: { id: string; name?: string }) => entry.id === projectId);
  return {
    title: {
      absolute: `PI | ${project?.name ?? projectId ?? "Drafts"} - Drafts`,
    },
  };
}

export default async function IdeasPage(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const searchParams = await props.searchParams;
  const projectId = await resolvePIIdeaProjectId(searchParams.project);
  const board = await getPIIdeaBoard(projectId);
  const executionRoot = getPIIdeaExecutionRoot();
  const [pageData, remoteOverview, workspaceFiles] = await Promise.all([
    getDashboardPageData("all"),
    getRemoteApprovalOverview(),
    readPIWorkspaceFiles(executionRoot),
  ]);
  const connectedCount = remoteOverview.agents.filter(
    (agent: { connectionState: string }) => agent.connectionState === "connected",
  ).length;

  return (
    <PIWorkspaceShell
      active="drafts"
      title="Draft reusable task specs"
      subtitle={`Save markdown task drafts, then send them to a connected agent. Project folders are created under ${executionRoot}.`}
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={executionRoot}
      workspaceFiles={workspaceFiles}
    >
      <PIIdeaBoard
        initialData={board}
        initialRemoteOverview={remoteOverview}
        projectId={projectId}
        executionRoot={executionRoot}
        mode="full"
      />
    </PIWorkspaceShell>
  );
}
