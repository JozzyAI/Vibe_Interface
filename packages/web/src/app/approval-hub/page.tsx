import type { Metadata } from "next";
import { PIApprovalInbox } from "@/components/PIApprovalInbox";
import { PIWorkspaceShell } from "@/components/PIWorkspaceShell";
import {
  getDashboardPageData,
} from "@/lib/dashboard-page-data";
import { getPIApprovalHubData } from "@/lib/pi-approval-hub";
import { getPIIdeaExecutionRoot } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

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

  return (
    <PIWorkspaceShell
      active="sessions"
      title="Sessions"
      subtitle="Approvals are blockers inside sessions. Handle them here, then jump back into the live CLI."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
    >
      <PIApprovalInbox initialCards={cards} initialRemoteOverview={remoteOverview} />
    </PIWorkspaceShell>
  );
}
