import type { PIApprovalHubData, RemoteAgentJob, RemoteApprovalOverview } from "@/lib/types";

interface ProjectHubCard {
  projectId: string;
  projectName: string;
  hub: PIApprovalHubData;
}

interface Props {
  cards: ProjectHubCard[];
  remoteOverview: RemoteApprovalOverview;
  activeHref?: string;
}

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "just now";
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(diffMinutes) || diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function humanRemoteJobTitle(job: RemoteAgentJob): string {
  if (job.title.startsWith("Recovered remote job:")) return "Restored remote session";
  if (job.title.startsWith("Resume Codex session:")) return "Resumed Codex session";
  return job.title;
}

function shortRemoteJobId(jobId: string): string {
  return jobId.replace(/^raj_/, "").slice(0, 8);
}

function remoteJobNeedsRestart(job: RemoteAgentJob): boolean {
  return Boolean(job.restartRequiredAt || job.logTail?.toLowerCase().includes("please restart codex"));
}

function remoteJobIsDegraded(job: RemoteAgentJob): boolean {
  const lower = `${job.error ?? ""}\n${job.logTail ?? ""}`.toLowerCase();
  if (!lower.includes("provider_heartbeat_failed")) return false;
  return !lower.includes("gpt-5") && !lower.includes("openai codex");
}

function remoteJobIsIdle(job: RemoteAgentJob): boolean {
  if (job.status !== "running") return false;
  const lower = (job.logTail ?? "").toLowerCase();
  if (!lower.includes("gpt-5") && !lower.includes("openai codex")) return false;
  const recent = lower
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
  return recent.includes("gpt-5") && !recent.includes("thinking");
}

function statusDot(status: string, pendingApprovalCount = 0): string {
  if (pendingApprovalCount > 0 || status.includes("awaiting")) return "bg-[#d99a1b]";
  if (status === "restart required" || status === "degraded") return "bg-[#d99a1b]";
  if (status === "running" || status === "queued" || status === "working") return "bg-[#25a55f]";
  if (status === "failed" || status === "disconnected") return "bg-[#e5533d]";
  return "bg-[#9aa1ad]";
}

export function getPISessionSidebarCount(cards: ProjectHubCard[], remoteOverview: RemoteApprovalOverview): number {
  return remoteOverview.jobs.length + cards.reduce((count, card) => count + card.hub.fleet.length, 0);
}

export function PISessionSidebar({ cards, remoteOverview, activeHref }: Props) {
  const remoteSessionItems = remoteOverview.jobs.map((job) => {
    const href = `/remote-sessions/${encodeURIComponent(job.jobId)}`;
    const status = remoteJobNeedsRestart(job)
      ? "restart required"
      : remoteJobIsDegraded(job)
        ? "degraded"
        : remoteJobIsIdle(job)
          ? "idle"
          : job.status;
    return {
      key: `remote-${job.jobId}`,
      title: humanRemoteJobTitle(job),
      subtitle: `${shortRemoteJobId(job.jobId)} - ${status} - ${formatRelativeTime(job.updatedAt)}`,
      status,
      pendingApprovalCount: remoteOverview.requests.filter(
        (request) => request.agentId === job.agentId && request.status === "open",
      ).length,
      href,
      updatedAt: job.updatedAt,
    };
  });
  const aoSessionItems = cards.flatMap((card) =>
    card.hub.fleet.map((session) => {
      const href = `/sessions/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(card.projectId)}`;
      return {
        key: `pi-${session.sessionId}`,
        title: session.sessionTitle,
        subtitle: `${session.status} - ${formatRelativeTime(session.lastActivityAt)}`,
        status: session.piState ?? session.status,
        pendingApprovalCount: session.pendingApprovalCount,
        href,
        updatedAt: session.lastActivityAt,
      };
    }),
  );
  const sessionItems = [...remoteSessionItems, ...aoSessionItems]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 24);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#a1a5ad]">
          Sessions
        </p>
        <span className="rounded-full border border-[#e3e4e5] px-2.5 py-1 text-[11px] font-semibold text-[#8b9099]">
          {sessionItems.length}
        </span>
      </div>
      <a
        href="/sessions/new"
        className={[
          "mb-4 flex items-center justify-center gap-2 rounded-xl border border-dashed border-[#d9dcdf] px-3 py-3 text-[13px] font-semibold text-[#5f4fb8] hover:bg-[#f7f7f6] hover:no-underline",
          activeHref === "/sessions/new" ? "bg-[#eef0f1]" : "",
        ].join(" ")}
      >
        <span className="text-[18px] leading-none">+</span>
        Add session
      </a>
      <div className="space-y-2">
        {sessionItems.length > 0 ? (
          sessionItems.map((item) => {
            const isActive = item.href === activeHref;
            return (
              <a
                key={item.key}
                href={item.href}
                className={[
                  "group block rounded-xl px-3 py-3 hover:bg-[#f4f5f5] hover:no-underline",
                  isActive ? "bg-[#eef0f1]" : "",
                ].join(" ")}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 h-2.5 w-2.5 rounded-full ${statusDot(item.status, item.pendingApprovalCount)}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-[#25272d]">
                      {item.title}
                    </p>
                    <p className="mt-1 truncate text-[12px] text-[#8b9099]">{item.subtitle}</p>
                  </div>
                  {item.pendingApprovalCount > 0 ? (
                    <span className="rounded-full bg-[#fff1c6] px-2 py-0.5 text-[10px] font-semibold text-[#9a6b00]">
                      approve
                    </span>
                  ) : null}
                </div>
              </a>
            );
          })
        ) : (
          <div className="rounded-xl border border-dashed border-[#e1e2e3] p-4 text-[13px] text-[#8b9099]">
            No sessions yet.
          </div>
        )}
      </div>
    </>
  );
}
