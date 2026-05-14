import type { Metadata } from "next";
import { PIApprovalInbox } from "@/components/PIApprovalInbox";
import { getPISessionSidebarCount, PISessionSidebar } from "@/components/PISessionSidebar";
import { PIWorkspaceShell } from "@/components/PIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getPIApprovalHubData } from "@/lib/pi-approval-hub";
import { getPIIdeaExecutionRoot } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    absolute: "PI | PI Sessions",
  },
};

export default async function SessionsPage() {
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
  const needsCount =
    cards.reduce((total: number, card: { hub?: { stats?: { inbox?: number; failed?: number; running?: number } } }) => total + (card.hub?.stats?.inbox ?? 0) + (card.hub?.stats?.failed ?? 0), 0) +
    remoteOverview.stats.pending +
    remoteOverview.stats.failed;
  const runningCount =
    cards.reduce((total: number, card: { hub?: { stats?: { running?: number } } }) => total + (card.hub?.stats?.running ?? 0), 0) +
    remoteOverview.stats.running;

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
      sidebarContent={<PISessionSidebar cards={cards} remoteOverview={remoteOverview} />}
      sidebarFooter={`${sessionCount} session${sessionCount === 1 ? "" : "s"} shown`}
      rightSidebarTitle="Sessions"
      rightSidebarContent={
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#a1a5ad]">
              Overview
            </p>
            <h2 className="mt-2 text-[24px] font-semibold tracking-[-0.04em] text-[#1e2026]">
              Session wall
            </h2>
            <p className="mt-2 text-[13px] leading-6 text-[#626873]">
              Approvals first. Running work one click away.
            </p>
            <div className="mt-5 grid grid-cols-3 gap-2">
              {[
                ["Needs", needsCount],
                ["Running", runningCount],
                ["Total", sessionCount],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-[#e4e4e0] bg-[#f5f3f0] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b9099]">
                    {label}
                  </p>
                  <p className="mt-2 text-[24px] font-semibold text-[#1e2026]">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 space-y-2 rounded-2xl bg-[#f5f3f0] p-3 text-[12px] leading-5 text-[#626873]">
              <p>{connectedCount} machine{connectedCount === 1 ? "" : "s"} online</p>
              <p>{cards.length} project{cards.length === 1 ? "" : "s"} tracked</p>
              <p className="truncate">root: {workspaceRoot}</p>
            </div>
          </div>
        </div>
      }
      hideHeader
    >
      <PIApprovalInbox initialCards={cards} initialRemoteOverview={remoteOverview} hideSummary />
    </PIWorkspaceShell>
  );
}
