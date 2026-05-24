import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { VIWorkbench } from "@/components/VIWorkbench";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";
import { getVIIdeaExecutionRoot } from "@/lib/vi-ideas";
import { readVIWorkspaceFiles } from "@/lib/vi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/backend";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return { title: { absolute: `VI | ${projectName}` } };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData(projectFilter);
  const workspaceRoot = getVIIdeaExecutionRoot();
  const [remoteOverview, workspaceFiles] = await Promise.all([
    getRemoteApprovalOverview(),
    readVIWorkspaceFiles(workspaceRoot),
  ]);

  return (
    <VIWorkbench
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
