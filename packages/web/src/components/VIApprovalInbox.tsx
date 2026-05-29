"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { DirectTerminal } from "./DirectTerminal";
import type {
  VIApprovalFleetItem,
  VIApprovalHubData,
  VIApprovalInboxEntry,
  VIApprovalPermissionMode,
  RemoteAgentEvent,
  RemoteAgentJob,
  RemoteAgentSummary,
  RemoteApprovalOverview,
  RemoteApprovalRequest,
} from "@/lib/types";
import { useOverviewPolling } from "@/hooks/useOverviewPolling";

export interface ApprovalInboxProjectCardData {
  projectId: string;
  projectName: string;
  hub: VIApprovalHubData;
}

interface Props {
  initialCards: ApprovalInboxProjectCardData[];
  initialRemoteOverview: RemoteApprovalOverview;
  hideSummary?: boolean;
}

type WallItem =
  | {
      kind: "local";
      key: string;
      title: string;
      projectId: string;
      projectName: string;
      status: string;
      connection: string;
      tool: string;
      host: string;
      cwd: string;
      updatedAt: string;
      summary: string;
      permissionMode: VIApprovalPermissionMode;
      timeoutSeconds: number;
      requests: VIApprovalInboxEntry[];
      session: VIApprovalFleetItem;
    }
  | {
      kind: "remote";
      key: string;
      title: string;
      status: string;
      connection: string;
      tool: string;
      host: string;
      cwd: string;
      updatedAt: string;
      summary: string;
      permissionMode: VIApprovalPermissionMode;
      timeoutSeconds: number;
      requests: RemoteApprovalRequest[];
      agent: RemoteAgentSummary;
      job: RemoteAgentJob;
    };

const MODE_META: Record<VIApprovalPermissionMode, { label: string; next: VIApprovalPermissionMode }> = {
  manual: { label: "Manual", next: "timeout_allow" },
  timeout_allow: { label: "10s auto", next: "always_allow" },
  always_allow: { label: "Always allow", next: "manual" },
};

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(error?.error ?? "Request failed");
  }
  return (await response.json()) as T;
}

function stripAnsi(input: string): string {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  return input
    .replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, "g"), "")
    .replace(new RegExp(`${esc}[PX^_].*?${esc}\\\\`, "gs"), "")
    .replace(new RegExp(`${esc}[@-_]`, "g"), "");
}

function truncate(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "No output yet.";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function recentTerminalLine(logTail: string | undefined): string {
  const lines = stripAnsi(logTail ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "Waiting for remote output.";
}

function terminalPreviewLines(logTail: string | undefined, maxLines = 5): string[] {
  return stripAnsi(logTail ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-maxLines);
}

function remoteDisplayStatus(job: RemoteAgentJob): string {
  const clean = stripAnsi(job.logTail ?? "").toLowerCase();
  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const recent = lines.slice(-18).join("\n");
  if (job.status !== "running") return job.status;
  if (recent.includes("press enter") || recent.includes("choose an option")) return "idle";
  if (/^\s*[›>•*-]?\s*\d+[.)]\s+/.test(recent)) return "idle";
  const tail = lines.slice(-8).join("\n");
  if ((tail.includes("gpt-5") || tail.includes("openai codex")) && !tail.includes("thinking")) return "idle";
  return "running";
}

function statusTone(status: string): string {
  if (status === "running" || status === "working" || status === "connected") {
    return "border-[var(--color-status-ok)] bg-[var(--color-status-ok-soft)] text-[var(--color-status-ok)]";
  }
  if (status === "idle" || status === "queued" || status === "pending" || status.includes("awaiting")) {
    return "border-[var(--color-status-attention)] bg-[var(--color-status-attention-soft)] text-[var(--color-status-attention)]";
  }
  if (status === "failed" || status === "killed" || status === "disconnected") {
    return "border-[var(--color-accent-red)] bg-[var(--color-accent-red-soft)] text-[var(--color-accent-red)]";
  }
  return "border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] text-[var(--color-text-tertiary)]";
}

function modeLabel(mode: VIApprovalPermissionMode): string {
  return MODE_META[mode].label;
}

function isAttentionItem(item: WallItem): boolean {
  return item.requests.length > 0 || item.status === "failed" || item.connection === "disconnected";
}

function isRunningItem(item: WallItem): boolean {
  return !isAttentionItem(item) && (item.status === "running" || item.status === "idle" || item.status === "queued");
}

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(diffMinutes)) return "unknown";
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function eventLabel(type: string): string {
  return type.replace(/\./g, " › ").replace(/_/g, " ");
}

function lastEventForItem(item: WallItem, events: RemoteAgentEvent[]): RemoteAgentEvent | undefined {
  if (item.kind !== "remote") return undefined;
  const jobId = item.job.jobId;
  const agentId = item.agent.agentId;
  return events.find((e) => e.jobId === jobId || e.agentId === agentId);
}

export function VIApprovalInbox({ initialCards, initialRemoteOverview, hideSummary }: Props) {
  const [cards, setCards] = useState(initialCards);
  const [remoteOverview, setRemoteOverview] = useState(initialRemoteOverview);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setCards(initialCards);
  }, [initialCards]);

  useEffect(() => {
    setRemoteOverview(initialRemoteOverview);
  }, [initialRemoteOverview]);

  const refreshProject = async (projectId: string): Promise<VIApprovalHubData> =>
    requestJson<VIApprovalHubData>(`/api/vi/approval-hub?project=${encodeURIComponent(projectId)}`);

  const refreshAll = async () => {
    const [nextCards, nextRemoteOverview] = await Promise.all([
      Promise.all(
        cards.map(async (card) => ({
          ...card,
          hub: await refreshProject(card.projectId),
        })),
      ),
      requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"),
    ]);
    const currentSessionCount =
      cards.reduce((count, card) => count + card.hub.fleet.length, 0) + remoteOverview.jobs.length;
    const nextSessionCount =
      nextCards.reduce((count, card) => count + card.hub.fleet.length, 0) + nextRemoteOverview.jobs.length;
    if (currentSessionCount > 0 && nextSessionCount === 0) return;
    setCards(nextCards);
    setRemoteOverview((current) =>
      current.jobs.length > 0 && nextRemoteOverview.jobs.length === 0
        ? { ...nextRemoteOverview, jobs: current.jobs, requests: current.requests }
        : nextRemoteOverview,
    );
  };

  // Overview polling via shared hook (level 1 — 8s, no relay call duplication)
  useOverviewPolling({
    level: 1,
    onData: (nextOverview) => {
      setRemoteOverview((current) =>
        current.jobs.length > 0 && nextOverview.jobs.length === 0
          ? { ...nextOverview, jobs: current.jobs, requests: current.requests }
          : nextOverview,
      );
    },
  });

  // Per-project hub data is local API (cheap) — keep its own 5s interval
  useEffect(() => {
    const refresh = () => {
      void Promise.all(
        cards.map(async (card) => ({
          ...card,
          hub: await requestJson<VIApprovalHubData>(
            `/api/vi/approval-hub?project=${encodeURIComponent(card.projectId)}`,
          ),
        })),
      )
        .then((nextCards) => {
          const currentCount = cards.reduce((n, c) => n + c.hub.fleet.length, 0);
          const nextCount = nextCards.reduce((n, c) => n + c.hub.fleet.length, 0);
          if (currentCount > 0 && nextCount === 0) return;
          setCards(nextCards);
        })
        .catch(() => void 0);
    };
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [cards]);

  const updateCard = (projectId: string, hub: VIApprovalHubData) => {
    setCards((current) =>
      current.map((card) => (card.projectId === projectId ? { ...card, hub } : card)),
    );
  };

  const remoteAgentsById = useMemo(
    () => new Map(remoteOverview.agents.map((agent) => [agent.agentId, agent])),
    [remoteOverview.agents],
  );

  const remoteRequestsByAgent = useMemo(() => {
    const grouped = new Map<string, RemoteApprovalRequest[]>();
    for (const request of remoteOverview.requests.filter((entry) => entry.status === "open")) {
      grouped.set(request.agentId, [...(grouped.get(request.agentId) ?? []), request]);
    }
    return grouped;
  }, [remoteOverview.requests]);

  const wallItems = useMemo<WallItem[]>(() => {
    const localItems: WallItem[] = cards.flatMap((card) =>
      card.hub.fleet.map((session) => ({
        kind: "local" as const,
        key: `pi-${card.projectId}-${session.sessionId}`,
        title: session.sessionTitle,
        projectId: card.projectId,
        projectName: card.projectName,
        status: session.piState ?? session.status,
        connection: "connected",
        tool: session.toolType,
        host: session.hostLabel,
        cwd: session.worktree ?? session.repoRoot ?? "unknown",
        updatedAt: session.lastActivityAt,
        summary: session.summary ?? "No session summary yet.",
        permissionMode: session.permissionMode,
        timeoutSeconds: session.timeoutSeconds,
        requests: card.hub.inbox.filter((request) => request.sessionId === session.sessionId),
        session,
      })),
    );

    const remoteItems: WallItem[] = remoteOverview.jobs.flatMap((job) => {
      const agent = remoteAgentsById.get(job.agentId);
      if (!agent) return [];
      return [
        {
          kind: "remote" as const,
          key: `remote-${job.jobId}`,
          title: job.title,
          status: remoteDisplayStatus(job),
          connection: agent.connectionState,
          tool: agent.toolType,
          host: agent.hostLabel,
          cwd: job.cwd ?? agent.worktree ?? agent.repoRoot ?? "unknown",
          updatedAt: job.updatedAt,
          summary: recentTerminalLine(job.logTail) || job.command.join(" "),
          permissionMode: agent.permissionMode,
          timeoutSeconds: agent.timeoutSeconds,
          requests: remoteRequestsByAgent.get(job.agentId) ?? [],
          agent,
          job,
        },
      ];
    });

    return [...localItems, ...remoteItems].sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  }, [cards, remoteAgentsById, remoteOverview.jobs, remoteRequestsByAgent]);

  const needsAttention = wallItems.filter(isAttentionItem);
  const running = wallItems.filter(isRunningItem);
  const other = wallItems.filter((item) => !isAttentionItem(item) && !isRunningItem(item)).slice(0, 12);

  const respond = (
    projectId: string,
    request: VIApprovalInboxEntry,
    action: "approve" | "reject" | "reply",
  ) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          if (request.sourceType === "native_command") {
            await requestJson(`/api/sessions/${encodeURIComponent(request.sessionId)}/native-approval`, {
              method: "POST",
              body: JSON.stringify({ action: action === "reject" ? "reject" : "approve" }),
            });
          } else {
            await requestJson("/api/vi/requests/respond", {
              method: "POST",
              body: JSON.stringify({
                sessionId: request.sessionId,
                requestId: request.requestId,
                action,
                response: "",
                kind: request.kind,
                title: request.title,
                message: request.message,
              }),
            });
          }
          updateCard(projectId, await refreshProject(projectId));
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to respond");
        }
      })();
    });

  const alwaysApprove = (projectId: string, request: VIApprovalInboxEntry) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          if (request.sourceType === "native_command") {
            await requestJson(`/api/sessions/${encodeURIComponent(request.sessionId)}/native-approval`, {
              method: "POST",
              body: JSON.stringify({ action: "always_approve" }),
            });
          } else {
            await requestJson("/api/vi/approval-hub/policy", {
              method: "POST",
              body: JSON.stringify({
                projectId,
                sessionId: request.sessionId,
                mode: "always_allow",
                timeoutSeconds: request.timeoutSeconds,
              }),
            });
            await requestJson("/api/vi/requests/respond", {
              method: "POST",
              body: JSON.stringify({
                sessionId: request.sessionId,
                requestId: request.requestId,
                action: "approve",
                response: "",
                kind: request.kind,
                title: request.title,
                message: request.message,
              }),
            });
          }
          updateCard(projectId, await refreshProject(projectId));
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to always approve");
        }
      })();
    });

  const updateSessionPolicy = (
    projectId: string,
    sessionId: string,
    currentMode: VIApprovalPermissionMode,
    timeoutSeconds: number,
  ) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          const nextHub = await requestJson<VIApprovalHubData>("/api/vi/approval-hub/policy", {
            method: "POST",
            body: JSON.stringify({
              projectId,
              sessionId,
              mode: MODE_META[currentMode].next,
              timeoutSeconds,
            }),
          });
          updateCard(projectId, nextHub);
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to switch session approval mode");
        }
      })();
    });

  const updateRemotePolicy = (agent: RemoteAgentSummary, mode?: VIApprovalPermissionMode) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          await requestJson("/api/remote-agents/policy", {
            method: "POST",
            body: JSON.stringify({
              agentId: agent.agentId,
              mode: mode ?? MODE_META[agent.permissionMode].next,
              timeoutSeconds: agent.timeoutSeconds,
            }),
          });
          setRemoteOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview?bust=1"));
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to switch remote approval mode");
        }
      })();
    });

  const respondRemote = (
    request: RemoteApprovalRequest,
    action: "approve" | "reject",
    agent?: RemoteAgentSummary,
    always = false,
  ) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          if (always && agent) {
            await requestJson("/api/remote-agents/policy", {
              method: "POST",
              body: JSON.stringify({
                agentId: agent.agentId,
                mode: "always_allow",
                timeoutSeconds: agent.timeoutSeconds,
              }),
            });
          }
          await requestJson("/api/remote-agents/requests/respond", {
            method: "POST",
            body: JSON.stringify({ requestId: request.requestId, action }),
          });
          setRemoteOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview?bust=1"));
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to respond to remote approval");
        }
      })();
    });

  const archiveRemoteJob = (item: Extract<WallItem, { kind: "remote" }>) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(item.job.jobId)}/archive`, {
            method: "POST",
            body: JSON.stringify({ agentId: item.agent.agentId }),
          });
          setRemoteOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview?bust=1"));
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to archive remote session");
        }
      })();
    });

  return (
    <div className="grid gap-5">
      <section className={`${hideSummary ? "hidden" : ""} overflow-hidden rounded-[2rem] border border-[var(--color-border-default)] bg-[linear-gradient(135deg,rgba(97,102,204,0.16),transparent_38%),var(--color-bg-surface)] p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
              Sessions
            </p>
            <h1 className="mt-1 text-[32px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
              One wall for every agent
            </h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-7 text-[var(--color-text-secondary)]">
              Approvals float to the top. Everything else stays small, scannable, and one click away from the live CLI.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Needs" value={needsAttention.length} />
            <MiniStat label="Running" value={running.length} />
            <MiniStat label="Total" value={wallItems.length} />
          </div>
        </div>
        {error ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red-soft)] p-3 text-[13px] text-[var(--color-accent-red)]">
            {error}
          </div>
        ) : null}
      </section>

      <SessionSection title="Needs attention" empty="No pending approvals or broken sessions right now.">
        {needsAttention.map((item) => (
          <SessionWallCard
            key={item.key}
            item={item}
            isPending={isPending}
            onModeClick={() =>
              item.kind === "local"
                ? updateSessionPolicy(item.projectId, item.session.sessionId, item.permissionMode, item.timeoutSeconds)
                : updateRemotePolicy(item.agent)
            }
            onArchive={item.kind === "remote" ? () => archiveRemoteJob(item) : undefined}
            onApprove={(request) =>
              item.kind === "local"
                ? respond(item.projectId, request as VIApprovalInboxEntry, "approve")
                : respondRemote(request as RemoteApprovalRequest, "approve", item.agent)
            }
            onAlwaysApprove={(request) =>
              item.kind === "local"
                ? alwaysApprove(item.projectId, request as VIApprovalInboxEntry)
                : respondRemote(request as RemoteApprovalRequest, "approve", item.agent, true)
            }
            onReject={(request) =>
              item.kind === "local"
                ? respond(item.projectId, request as VIApprovalInboxEntry, "reject")
                : respondRemote(request as RemoteApprovalRequest, "reject", item.agent)
            }
          />
        ))}
      </SessionSection>

      <SessionSection title="Running" empty="No active sessions yet. Start from Ideas or resume a remote Codex session.">
        {running.map((item) => (
          <SessionWallCard
            key={item.key}
            item={item}
            isPending={isPending}
            lastEvent={lastEventForItem(item, remoteOverview.events)}
            onModeClick={() =>
              item.kind === "local"
                ? updateSessionPolicy(item.projectId, item.session.sessionId, item.permissionMode, item.timeoutSeconds)
                : updateRemotePolicy(item.agent)
            }
            onArchive={item.kind === "remote" ? () => archiveRemoteJob(item) : undefined}
          />
        ))}
      </SessionSection>

      {other.length > 0 ? (
        <SessionSection title="Recent" empty="">
          {other.map((item) => (
            <SessionWallCard
              key={item.key}
              item={item}
              isPending={isPending}
              lastEvent={lastEventForItem(item, remoteOverview.events)}
              onModeClick={() =>
                item.kind === "local"
                  ? updateSessionPolicy(item.projectId, item.session.sessionId, item.permissionMode, item.timeoutSeconds)
                  : updateRemotePolicy(item.agent)
              }
              onArchive={item.kind === "remote" ? () => archiveRemoteJob(item) : undefined}
            />
          ))}
        </SessionSection>
      ) : null}
    </div>
  );
}

function SessionSection({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          {title}
        </h2>
      </div>
      {hasChildren ? (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">{children}</div>
      ) : (
        <div className="rounded-3xl border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-5 text-[13px] text-[var(--color-text-secondary)]">
          {empty}
        </div>
      )}
    </section>
  );
}

function SessionWallCard({
  item,
  isPending,
  lastEvent,
  onModeClick,
  onApprove,
  onAlwaysApprove,
  onReject,
  onArchive,
}: {
  item: WallItem;
  isPending: boolean;
  lastEvent?: RemoteAgentEvent;
  onModeClick: () => void;
  onApprove?: (request: VIApprovalInboxEntry | RemoteApprovalRequest) => void;
  onAlwaysApprove?: (request: VIApprovalInboxEntry | RemoteApprovalRequest) => void;
  onReject?: (request: VIApprovalInboxEntry | RemoteApprovalRequest) => void;
  onArchive?: () => void;
}) {
  const primaryRequest = item.requests[0];
  const openHref =
    item.kind === "local"
      ? `/sessions/${encodeURIComponent(item.session.sessionId)}?project=${encodeURIComponent(item.projectId)}`
      : `/remote-sessions/${encodeURIComponent(item.job.jobId)}`;

  return (
    <article className="group overflow-hidden rounded-[1.6rem] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div
        className={
          item.requests.length > 0
            ? "h-1.5 bg-[var(--color-status-attention)]"
            : "h-1.5 bg-gradient-to-r from-[var(--color-accent)] to-transparent"
        }
      />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {item.kind === "local" ? item.projectName : "Remote CLI"} / {item.host}
            </p>
            <h3 className="mt-2 line-clamp-2 text-[18px] font-semibold leading-6 text-[var(--color-text-primary)]">
              {item.title}
            </h3>
          </div>
          <button
            type="button"
            disabled={isPending}
            onClick={onModeClick}
            className="shrink-0 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
            title={`Switch to ${MODE_META[item.permissionMode].next}`}
          >
            {modeLabel(item.permissionMode)}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone(item.status)}`}>
            {item.status}
          </span>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone(item.connection)}`}>
            {item.connection}
          </span>
          <span className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)]">
            {item.tool}
          </span>
        </div>

        <p className="mt-4 line-clamp-2 text-[13px] leading-6 text-[var(--color-text-secondary)]">
          {truncate(item.summary, 120)}
        </p>

        {lastEvent ? (
          <p className="mt-2 truncate text-[11px] text-[var(--color-text-tertiary)]">
            <span className="font-semibold">{eventLabel(lastEvent.type)}</span>
            {" · "}
            {formatRelativeTime(lastEvent.createdAt)}
          </p>
        ) : null}

        {item.kind === "remote" && item.job.tmuxSession ? (
          <div className="mt-4 overflow-hidden rounded-[1.1rem] bg-[#07080d] shadow-[0_18px_45px_rgba(7,10,18,0.14)] ring-1 ring-white/5">
            <DirectTerminal
              sessionId={item.job.tmuxSession}
              variant="orchestrator"
              appearance="dark"
              height="136px"
              chromeless
              readOnly
              showFloatingControls={false}
              fontSize={11.5}
            />
          </div>
        ) : item.kind === "remote" ? (
          <div className="mt-4 overflow-hidden rounded-[1.1rem] bg-[#07080d] shadow-[0_18px_45px_rgba(7,10,18,0.14)] ring-1 ring-white/5">
            <pre className="m-0 h-[136px] overflow-hidden whitespace-pre-wrap break-words px-5 py-4 font-mono text-[11.5px] leading-6 text-[#e6eeff]">
              {(terminalPreviewLines(item.job.logTail).length > 0
                ? terminalPreviewLines(item.job.logTail)
                : ["Waiting for remote output..."]
              ).join("\n")}
            </pre>
          </div>
        ) : null}

        {primaryRequest ? (
          <ApprovalMiniCard
            request={primaryRequest}
            isPending={isPending}
            onApprove={() => onApprove?.(primaryRequest)}
            onAlwaysApprove={() => onAlwaysApprove?.(primaryRequest)}
            onReject={() => onReject?.(primaryRequest)}
          />
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-2">
          <a
            href={openHref}
            className="rounded-full bg-[var(--color-text-primary)] px-4 py-2 text-[12px] font-semibold text-[var(--color-bg-base)] hover:no-underline"
          >
            Open session
          </a>
          <div className="flex items-center gap-2">
            {item.requests.length > 1 ? (
              <span className="rounded-full border border-[var(--color-status-attention)] px-3 py-2 text-[11px] font-semibold text-[var(--color-status-attention)]">
                +{item.requests.length - 1} more
              </span>
            ) : null}
            {onArchive ? (
              <button
                type="button"
                disabled={isPending}
                onClick={onArchive}
                className="rounded-full border border-[var(--color-border-default)] px-3 py-2 text-[11px] font-semibold text-[var(--color-text-tertiary)] transition hover:border-[var(--color-accent-red)] hover:text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Archive
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function ApprovalMiniCard({
  request,
  isPending,
  onApprove,
  onAlwaysApprove,
  onReject,
}: {
  request: VIApprovalInboxEntry | RemoteApprovalRequest;
  isPending: boolean;
  onApprove: () => void;
  onAlwaysApprove: () => void;
  onReject: () => void;
}) {
  const command =
    "context" in request
      ? request.context.command ?? request.nativeCommand ?? null
      : request.command ?? null;
  const suggestedCommand = "suggestedCommand" in request ? request.suggestedCommand : null;
  const isExternalAction = "eventType" in request && request.eventType === "external_action";
  const badge = isExternalAction ? "external action" : "approval";

  return (
    <div className="mt-4 rounded-2xl border border-[var(--color-status-attention)]/45 bg-[var(--color-status-attention-soft)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">{request.title}</p>
        <span className="rounded-full border border-[var(--color-status-attention)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-status-attention)]">
          {badge}
        </span>
      </div>
      <p className="mt-2 line-clamp-3 text-[12px] leading-6 text-[var(--color-text-secondary)]">
        {request.message}
      </p>
      {command ? (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--color-bg-base)] px-3 py-2 text-[11px] leading-5 text-[var(--color-text-primary)]">
          {command}
        </pre>
      ) : null}
      {suggestedCommand ? (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--color-bg-base)] px-3 py-2 text-[11px] leading-5 text-[var(--color-text-primary)]">
          {suggestedCommand}
        </pre>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={onApprove}
          className="rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onAlwaysApprove}
          className="rounded-full border border-[var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Always approve
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onReject}
          className="rounded-full border border-[var(--color-accent-red)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        {label}
      </p>
      <p className="mt-1 text-[22px] font-semibold text-[var(--color-text-primary)]">{value}</p>
    </div>
  );
}
