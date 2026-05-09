import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { PIWorkbench } from "@/components/PIWorkbench";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";
import { getPIIdeaExecutionRoot } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return { title: { absolute: `PI | ${projectName}` } };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData(projectFilter);
  const workspaceRoot = getPIIdeaExecutionRoot();
  const [remoteOverview, workspaceFiles] = await Promise.all([
    getRemoteApprovalOverview(),
    readPIWorkspaceFiles(workspaceRoot),
  ]);

  return (
    <PIWorkbench
      initialSessions={pageData.sessions}
      initialRemoteOverview={remoteOverview}
      ideaBoard={pageData.ideaBoard}
      projectId={pageData.selectedProjectId}
      projectName={pageData.projectName}
      projects={pageData.projects}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
    />
  );
}
