import type { Metadata } from "next";
import { VIAgentsEntry } from "@/components/VIAgentsEntry";
import { VIWorkspaceShell } from "@/components/VIWorkspaceShell";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getVIIdeaExecutionRoot } from "@/lib/vi-ideas";
import { readVIWorkspaceFiles } from "@/lib/vi-workspace-files";
import type { RemoteAgentSummary, RemoteApprovalOverview } from "@/lib/types";

const EMPTY_OVERVIEW: RemoteApprovalOverview = {
  generatedAt: "",
  stats: { agents: 0, running: 0, pending: 0, failed: 0 },
  agents: [], requests: [], jobs: [], events: [], enrollments: [], recentEnrollments: [],
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    absolute: "VI | Add Machine",
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

function MachineSidebar({ agents }: { agents: RemoteAgentSummary[] }) {
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
        {sortedAgents.map((agent) => (
          <a
            key={agent.agentId}
            href={`/agents?machine=${encodeURIComponent(agent.agentId)}`}
            className="block rounded-xl px-3 py-3 hover:bg-[#f4f5f5] hover:no-underline"
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
              </div>
            </div>
          </a>
        ))}
      </div>

      <a
        href="/agents/new"
        className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-dashed border-[#d9dcdf] bg-[#eef0f1] px-3 py-3 text-[13px] font-semibold text-[#5f4fb8] hover:bg-[#f7f7f6] hover:no-underline"
      >
        <span className="text-[18px] leading-none">+</span>
        Add machine
      </a>
    </>
  );
}

export default async function AddMachinePage() {
  const pageData = await getDashboardPageData("all");
  const workspaceRoot = getVIIdeaExecutionRoot();
  const workspaceFiles = await readVIWorkspaceFiles(workspaceRoot);

  return (
    <VIWorkspaceShell
      active="agents"
      title="Add machine"
      subtitle="Create a one-time pairing code for a computer or server running Codex CLI or Claude Code."
      projectName={pageData.projectName}
      projects={pageData.projects}
      connectedCount={0}
      workspaceRoot={workspaceRoot}
      workspaceFiles={workspaceFiles}
      sidebarContent={<MachineSidebar agents={[]} />}
    >
      <VIAgentsEntry initialRemoteOverview={EMPTY_OVERVIEW} view="new" />
    </VIWorkspaceShell>
  );
}
