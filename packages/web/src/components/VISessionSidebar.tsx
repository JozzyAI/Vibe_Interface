"use client";

import { useState } from "react";
import { useOverviewPolling } from "@/hooks/useOverviewPolling";
import type { VIApprovalHubData, RemoteAgentJob, RemoteApprovalOverview } from "@/lib/types";

const EMPTY_OVERVIEW: RemoteApprovalOverview = {
  generatedAt: "",
  stats: { agents: 0, running: 0, pending: 0, failed: 0 },
  agents: [],
  requests: [],
  jobs: [],
  events: [],
  enrollments: [],
  recentEnrollments: [],
};

// Strip ANSI escape sequences so logTail pattern matching works on plain text.
const ANSI_STRIP_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX^_].*?\x1b\\|\x1b[@-_]/gs;
function stripAnsiForStatus(s: string): string {
  return s.replace(ANSI_STRIP_RE, "");
}

type DisplayStatus = {
  label: string;
  dotClass: string;
};

/**
 * Derive a human-readable display status from a running remote job.
 *
 * Priority (highest to lowest):
 *   approval needed > waiting for input > working (busy) > restart/degraded > default running
 *
 * Signals used:
 *   - pendingApprovalCount from overview.requests
 *   - job.providerState (set by vi-agent detect_provider_state hook/PTY scraping)
 *   - job.logTail pattern matching for approval dialogs and REPL idle prompt
 */
function deriveRemoteJobDisplayStatus(
  job: RemoteAgentJob,
  pendingApprovalCount: number,
): DisplayStatus {
  // Terminal states — show as-is
  if (job.status === "completed") return { label: "completed", dotClass: "bg-[#9aa1ad]" };
  if (job.status === "failed")    return { label: "failed",    dotClass: "bg-[#e5533d]" };
  if (job.status === "queued")    return { label: "queued",    dotClass: "bg-[#9aa1ad]" };

  // Approval needed — most urgent for running sessions
  if (
    pendingApprovalCount > 0 ||
    job.providerState?.state === "waiting_approval"
  ) {
    return { label: "approval needed", dotClass: "bg-[#d99a1b]" };
  }

  // Waiting for user input — from providerState (daemon PTY/hook scraping)
  if (
    job.providerState?.state === "waiting_input" &&
    (job.providerState.confidence ?? 0) >= 0.5
  ) {
    return { label: "waiting for input", dotClass: "bg-[#d99a1b]" };
  }

  // Pattern matching on logTail for approval dialogs and REPL idle prompt.
  // Only look at the last ~20 lines to avoid false positives from old output.
  if (job.logTail) {
    const clean = stripAnsiForStatus(job.logTail);
    const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const recent = lines.slice(-20).join("\n").toLowerCase();

    // Claude Code tool-approval dialogs
    const isApproval =
      (recent.includes("do you want to ") && recent.includes("esc to cancel")) ||
      (recent.includes("1. yes") && recent.includes("2. yes")) ||
      (recent.includes("1. yes") && recent.includes("3. no")) ||
      recent.includes("do you want to proceed");
    if (isApproval) return { label: "approval needed", dotClass: "bg-[#d99a1b]" };

    // Claude REPL idle prompt ("? for shortcuts · ← for agents")
    if (recent.includes("? for shortcuts")) {
      return { label: "waiting for input", dotClass: "bg-[#d99a1b]" };
    }
  }

  // Restart required / degraded
  if (remoteJobNeedsRestart(job)) return { label: "restart required", dotClass: "bg-[#d99a1b]" };
  if (remoteJobIsDegraded(job))   return { label: "degraded",         dotClass: "bg-[#d99a1b]" };

  // Actively working
  if (job.providerState?.state === "busy") return { label: "working", dotClass: "bg-[#25a55f]" };

  // Default: running without a finer state
  return { label: "working", dotClass: "bg-[#25a55f]" };
}

interface ProjectHubCard {
  projectId: string;
  projectName: string;
  hub: VIApprovalHubData;
}

interface Props {
  cards: ProjectHubCard[];
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


export function getVISessionSidebarCount(cards: ProjectHubCard[], remoteOverview: RemoteApprovalOverview): number {
  return remoteOverview.jobs.length + cards.reduce((count, card) => count + card.hub.fleet.length, 0);
}

export function VISessionSidebar({ cards, activeHref }: Props) {
  const [remoteOverview, setRemoteOverview] = useState<RemoteApprovalOverview>(EMPTY_OVERVIEW);
  useOverviewPolling({ level: 1, onData: setRemoteOverview });
  const remoteSessionItems = remoteOverview.jobs.map((job) => {
    const href = `/remote-sessions/${encodeURIComponent(job.jobId)}`;
    const pendingApprovalCount = remoteOverview.requests.filter(
      (request) => request.agentId === job.agentId && request.status === "open",
    ).length;
    const displayStatus = deriveRemoteJobDisplayStatus(job, pendingApprovalCount);
    return {
      key: `remote-${job.jobId}`,
      title: humanRemoteJobTitle(job),
      subtitle: `${shortRemoteJobId(job.jobId)} · ${displayStatus.label} · ${formatRelativeTime(job.updatedAt)}`,
      dotClass: displayStatus.dotClass,
      pendingApprovalCount,
      href,
      updatedAt: job.updatedAt,
    };
  });
  const aoSessionItems = cards.flatMap((card) =>
    card.hub.fleet.map((session) => {
      const href = `/sessions/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(card.projectId)}`;
      const piStatus = session.piState ?? session.status;
      const piDotClass =
        session.pendingApprovalCount > 0
          ? "bg-[#d99a1b]"
          : piStatus === "working" || piStatus === "running"
            ? "bg-[#25a55f]"
            : piStatus === "errored" || piStatus === "failed"
              ? "bg-[#e5533d]"
              : "bg-[#9aa1ad]";
      return {
        key: `pi-${session.sessionId}`,
        title: session.sessionTitle,
        subtitle: `${piStatus} · ${formatRelativeTime(session.lastActivityAt)}`,
        dotClass: piDotClass,
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
                    className={`mt-1.5 h-2.5 w-2.5 rounded-full ${item.dotClass}`}
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
