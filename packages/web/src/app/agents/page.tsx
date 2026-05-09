import type { Metadata } from "next";
import { PIAgentsEntry } from "@/components/PIAgentsEntry";
import { PIWorkspaceShell } from "@/components/PIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getPIIdeaExecutionRoot } from "@/lib/pi-ideas";
import { readPIWorkspaceFiles } from "@/lib/pi-workspace-files";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";
import type { RemoteAgentSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    absolute: "PI | PI Machines",
  },
};

function machineTone(agent: RemoteAgentSummary): string {
  if (agent.connectionState === "connected") return "bg-[#25a55f]";
  if (agent.connectionState === "stale") return "bg-[#d99a1b]";
  return "bg-[#e5533d]";
}

function formatRelativeTime(iso: string): string {
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(diffMinutes) || diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function MachineSidebar({
  agents,
  selectedAgentId,
  activeAdd,
}: {
  agents: RemoteAgentSummary[];
  selectedAgentId?: string;
  activeAdd?: boolean;
}) {
  const sortedAgents = [...agents].sort((left, right) => {
    if (left.connectionState === "connected" && right.connectionState !== "connected") return -1;
    if (left.connectionState !== "connected" && right.connectionState === "connected") return 1;
    return new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime();
  });

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#a1a5ad]">
          Machines
        </p>
        <span className="rounded-full border border-[#e3e4e5] px-2.5 py-1 text-[11px] font-semibold text-[#8b9099]">
          {sortedAgents.length}
        </span>
      </div>

      <div className="space-y-2">
        {sortedAgents.length > 0 ? (
          sortedAgents.map((agent) => {
            const isActive = agent.agentId === selectedAgentId;
            return (
              <a
                key={agent.agentId}
                href={`/agents?machine=${encodeURIComponent(agent.agentId)}`}
                className={[
                  "block rounded-xl px-3 py-3 hover:bg-[#f4f5f5] hover:no-underline",
                  isActive ? "bg-[#eef0f1]" : "",
                ].join(" ")}
              >
                <div className="flex items-start gap-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${machineTone(agent)}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-[#25272d]">
                      {agent.displayName}
                    </p>
                    <p className="mt-1 truncate text-[12px] text-[#8b9099]">
                      {agent.hostLabel} - {formatRelativeTime(agent.lastSeenAt)}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-[#68707c]">
                        {agent.toolType}
                      </span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-[#68707c]">
                        {agent.projectLabel}
                      </span>
                    </div>
                  </div>
                </div>
              </a>
            );
          })
        ) : (
          <div className="rounded-xl border border-dashed border-[#e1e2e3] p-4 text-[13px] text-[#8b9099]">
            No machines connected yet.
          </div>
        )}
      </div>

      <a
        href="/agents/new"
        className={[
          "mt-4 flex items-center justify-center gap-2 rounded-xl border border-dashed border-[#d9dcdf] px-3 py-3 text-[13px] font-semibold text-[#5f4fb8] hover:bg-[#f7f7f6] hover:no-underline",
          activeAdd ? "bg-[#eef0f1]" : "",
        ].join(" ")}
      >
        <span className="text-[18px] leading-none">+</span>
        Add machine
      </a>
    </>
  );
}

export default async function AgentsPage(props: {
  searchParams?: Promise<{ machine?: string }>;
}) {
  const searchParams = await props.searchParams;
  const pageData = await getDashboardPageData("all");
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
      active="agents"
      title="Machines"
      subtitle="Connect computers and servers, then inspect each machine's current sessions and resumable history."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={connectedCount}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={
        <MachineSidebar
          agents={remoteOverview.agents}
          selectedAgentId={searchParams?.machine ?? remoteOverview.agents[0]?.agentId}
          activeAdd={false}
        />
      }
      sidebarFooter={`${connectedCount} online / ${remoteOverview.agents.length} known`}
    >
      <PIAgentsEntry
        initialRemoteOverview={remoteOverview}
        selectedAgentId={searchParams?.machine}
      />
    </PIWorkspaceShell>
  );
}
