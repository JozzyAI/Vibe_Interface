import type { Metadata } from "next";
import { PIApprovalInbox } from "@/components/PIApprovalInbox";
import { PIWorkspaceShell } from "@/components/PIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getPIApprovalHubData } from "@/lib/pi-approval-hub";
import { getPIIdeaExecutionRoot } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    absolute: "PI | PI Tasks",
  },
};

export default async function TasksPage() {
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
      subtitle="One place for running work, blocked approvals, failed sessions, and live CLI access."
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
