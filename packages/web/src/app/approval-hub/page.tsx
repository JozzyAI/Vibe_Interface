import type { Metadata } from "next";
import { VIApprovalInbox } from "@/components/VIApprovalInbox";
import { VIWorkspaceShell } from "@/components/VIWorkspaceShell";
import {
  getDashboardPageData,
} from "@/lib/dashboard-page-data";
import { getVIApprovalHubData } from "@/lib/vi-approval-hub";
import { getVIIdeaExecutionRoot } from "@/lib/vi-ideas";
import { readVIWorkspaceFiles } from "@/lib/vi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  await props.searchParams;
  return {
    title: {
      absolute: "PI | All Projects - Approval Hub",
    },
  };
}

export default async function ApprovalHubPage(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  await props.searchParams;
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

  return (
    <VIWorkspaceShell
      active="sessions"
      title="Sessions"
      subtitle="Approvals are blockers inside sessions. Handle them here, then jump back into the live CLI."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
    >
      <VIApprovalInbox initialCards={cards} initialRemoteOverview={remoteOverview} />
    </VIWorkspaceShell>
  );
}
