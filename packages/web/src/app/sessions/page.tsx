import type { Metadata } from "next";
import { VIApprovalInbox } from "@/components/VIApprovalInbox";
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

export const metadata: Metadata = {
  title: {
    absolute: "VI | VI Sessions",
  },
};

export default async function SessionsPage() {
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
  const needsCount = cards.reduce(
    (total: number, card: { hub?: { stats?: { inbox?: number; failed?: number } } }) =>
      total + (card.hub?.stats?.inbox ?? 0) + (card.hub?.stats?.failed ?? 0),
    0,
  );
  const runningCount = cards.reduce(
    (total: number, card: { hub?: { stats?: { running?: number } } }) =>
      total + (card.hub?.stats?.running ?? 0),
    0,
  );
  const sessionCount = cards.reduce(
    (total: number, card: { hub?: { fleet?: unknown[] } }) =>
      total + (card.hub?.fleet?.length ?? 0),
    0,
  );

  return (
    <VIWorkspaceShell
      active="sessions"
      title="Sessions"
      subtitle="One place for running work, blocked approvals, failed sessions, and live CLI access."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={0}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={<VISessionSidebar cards={cards} />}
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
              <p>machines online</p>
              <p>{cards.length} project{cards.length === 1 ? "" : "s"} tracked</p>
              <p className="truncate">root: {workspaceRoot}</p>
            </div>
          </div>
        </div>
      }
      hideHeader
    >
      <VIApprovalInbox initialCards={cards} initialRemoteOverview={EMPTY_OVERVIEW} hideSummary />
    </VIWorkspaceShell>
  );
}
