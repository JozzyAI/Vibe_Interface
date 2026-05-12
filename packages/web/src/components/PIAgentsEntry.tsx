"use client";

// Hardcoded LAN address so remote machines on the same WiFi get the correct pair command.
// Change this if the host machine's IP changes.
const PI_SERVER_ORIGIN = "http://192.168.1.83:3000";

import { useEffect, useMemo, useState, useTransition } from "react";
import type {
  RemoteAgentJob,
  RemoteAgentSessionHistoryItem,
  RemoteAgentSummary,
  RemoteAuthConnectorSummary,
  RemoteApprovalOverview,
  RemoteEnrollmentSummary,
} from "@/lib/types";

interface Props {
  initialRemoteOverview: RemoteApprovalOverview;
  selectedAgentId?: string;
  view?: "detail" | "new";
}

interface RemoteEnrollmentForm {
  displayName: string;
  projectLabel: string;
  expiresInMinutes: number;
}

const cardShell =
  "rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]";

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

function formatRelativeTime(iso: string): string {
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(diffMinutes) || diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function connectionTone(agent: RemoteAgentSummary): string {
  if (agent.connectionState === "connected") {
    return "border-[var(--color-status-ok)] text-[var(--color-status-ok)]";
  }
  if (agent.connectionState === "stale") {
    return "border-[var(--color-status-attention)] text-[var(--color-status-attention)]";
  }
  if (agent.connectionState === "disabled") {
    return "border-[var(--color-border-default)] text-[var(--color-text-tertiary)]";
  }
  return "border-[var(--color-accent-red)] text-[var(--color-accent-red)]";
}

function connectionOrder(state: string): number {
  if (state === "connected") return 0;
  if (state === "stale") return 1;
  if (state === "disconnected") return 2;
  return 3; // disabled
}

function jobTone(job: RemoteAgentJob): string {
  if (job.status === "running") return "border-[var(--color-status-ok)] text-[var(--color-status-ok)]";
  if (job.status === "queued") return "border-[var(--color-status-attention)] text-[var(--color-status-attention)]";
  if (job.status === "failed") return "border-[var(--color-accent-red)] text-[var(--color-accent-red)]";
  return "border-[var(--color-border-default)] text-[var(--color-text-secondary)]";
}

function authTone(status: string): string {
  if (status === "connected") return "border-[var(--color-status-ok)] text-[var(--color-status-ok)]";
  if (status === "missing" || status === "disconnected") {
    return "border-[var(--color-status-attention)] text-[var(--color-status-attention)]";
  }
  return "border-[var(--color-border-default)] text-[var(--color-text-secondary)]";
}

function authAction(status: string): string {
  if (status === "connected") return "Ready";
  if (status === "missing") return "Install";
  if (status === "disconnected") return "Login";
  return "Check";
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}` : sessionId;
}

function folderName(path: string | undefined): string {
  if (!path) return "unknown cwd";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function pairingCommand(enrollment: RemoteEnrollmentSummary | null): string | null {
  if (!enrollment || typeof window === "undefined") return null;
  return `pi-agent pair --server ${PI_SERVER_ORIGIN} --code ${enrollment.code} --start`;
}

function reconnectCommand(agent: RemoteAgentSummary, serverOrigin: string): string | null {
  if (!agent.stateFile) return null;
  return `pi-agent start-daemon --state-file ${agent.stateFile} --server ${serverOrigin}`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for HTTP (non-localhost) contexts where Clipboard API is unavailable
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) throw new Error("Copy failed — please copy the text manually");
}

export function PIAgentsEntry({ initialRemoteOverview, selectedAgentId, view = "detail" }: Props) {
  const [overview, setOverview] = useState(initialRemoteOverview);
  const [form, setForm] = useState<RemoteEnrollmentForm>({
    displayName: "My Machine",
    projectLabel: "local-machine",
    expiresInMinutes: 60,
  });
  const [latestEnrollment, setLatestEnrollment] = useState<RemoteEnrollmentSummary | null>(
    initialRemoteOverview.enrollments[0] ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [browserOrigin, setBrowserOrigin] = useState("http://localhost:3000");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setOverview(initialRemoteOverview);
  }, [initialRemoteOverview]);

  useEffect(() => {
    setBrowserOrigin(PI_SERVER_ORIGIN);
  }, []);

  const agents = useMemo(
    () =>
      [...overview.agents].sort((left, right) => {
        const orderDiff = connectionOrder(left.connectionState) - connectionOrder(right.connectionState);
        if (orderDiff !== 0) return orderDiff;
        return new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime();
      }),
    [overview.agents],
  );

  const connectedAgents = useMemo(
    () => agents.filter((agent) => agent.connectionState === "connected"),
    [agents],
  );

  const inactiveAgents = useMemo(
    () => agents.filter((agent) => agent.connectionState !== "connected"),
    [agents],
  );
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );

  const refreshOverview = async () => {
    setOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
  };

  const createConnectCode = () =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          setCopied(false);
          const created = await requestJson<{ enrollment: RemoteEnrollmentSummary }>(
            "/api/remote-agents/enrollments",
            {
              method: "POST",
              body: JSON.stringify({ ...form, toolType: "agent" }),
            },
          );
          setLatestEnrollment(created.enrollment);
          await refreshOverview();
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to create code");
        }
      })();
    });

  const command = pairingCommand(latestEnrollment);

  const copyCommand = () =>
    startTransition(() => {
      void (async () => {
        try {
          if (!command) return;
          setError(null);
          await copyText(command);
          setCopied(true);
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to copy command");
        }
      })();
    });

  const isNewMachineView = view === "new";

  return (
    <div className="grid gap-4">
      <section className={`${cardShell} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Machines
            </p>
            <h1 className="mt-1 text-[30px] font-semibold text-[var(--color-text-primary)]">
              {isNewMachineView
                ? "Add machine"
                : selectedAgent
                  ? selectedAgent.displayName
                  : "Connect your first machine"}
            </h1>
            <p className="mt-2 max-w-3xl text-[13px] leading-7 text-[var(--color-text-secondary)]">
              {isNewMachineView
                ? "Create a short-lived pairing code, then run the bridge command on the target computer."
                : selectedAgent
                ? "Current sessions and resumable history for this machine. Switch machines from the sidebar."
                : "Run a small bridge command on any computer or server where Codex CLI or Claude Code is installed."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <MiniStat label="Connected" value={connectedAgents.length} />
            <MiniStat label="Known" value={agents.length} />
          </div>
        </div>
        {error ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red-soft)] p-3 text-[13px] text-[var(--color-accent-red)]">
            {error}
          </div>
        ) : null}
      </section>

      {!isNewMachineView && selectedAgent ? (
        <section className={`${cardShell} p-5`}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                Machine detail
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-full border border-[var(--color-border-default)] px-3 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                  Machine
                </span>
                <span className="rounded-full border border-[var(--color-border-default)] px-3 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                  {selectedAgent.projectLabel}
                </span>
                <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${connectionTone(selectedAgent)}`}>
                  {selectedAgent.connectionState}
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                startTransition(() => {
                  void refreshOverview().catch((nextError) =>
                    setError(nextError instanceof Error ? nextError.message : "Failed to refresh"),
                  );
                });
              }}
              className="rounded-full border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
          <MachineDetailsEditor agent={selectedAgent} onRefresh={refreshOverview} />
          <MachineRow
            agent={selectedAgent}
            jobs={overview.jobs.filter((job) => job.agentId === selectedAgent.agentId)}
            serverOrigin={browserOrigin}
            onRefresh={refreshOverview}
          />
        </section>
      ) : !isNewMachineView ? (
        <section className={`${cardShell} p-5`}>
          <div className="rounded-2xl border border-dashed border-[var(--color-border-default)] px-4 py-5 text-[13px] text-[var(--color-text-secondary)]">
            No machines are connected right now. Add one below.
          </div>
        </section>
      ) : null}

      {isNewMachineView ? (
      <section className={`${cardShell} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Add machine
            </p>
            <h2 className="mt-1 text-[22px] font-semibold text-[var(--color-text-primary)]">
              Connect another computer
            </h2>
            <p className="mt-2 text-[13px] leading-6 text-[var(--color-text-secondary)]">
              Use a short-lived pairing code. The machine will show up in the sidebar after the bridge starts.
            </p>
          </div>
          <button
            type="button"
            disabled={isPending}
            onClick={createConnectCode}
            className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Create code
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Machine name
            </label>
            <input
              value={form.displayName}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({ ...current, displayName: value }));
              }}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)]"
            />
          </div>
          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Tag / label
            </label>
            <input
              value={form.projectLabel}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({ ...current, projectLabel: value }));
              }}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)]"
            />
          </div>
        </div>

        {latestEnrollment ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  One-time code
                </p>
                <p className="mt-1 text-[20px] font-semibold tracking-[0.12em] text-[var(--color-text-primary)]">
                  {latestEnrollment.code}
                </p>
              </div>
              <button
                type="button"
                disabled={!command || isPending}
                onClick={copyCommand}
                className="rounded-full border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {copied ? "Copied" : "Copy command"}
              </button>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-2xl bg-[var(--color-bg-surface)] px-4 py-3 text-[12px] leading-6 text-[var(--color-text-primary)]">
              {command}
            </pre>
          </div>
        ) : null}
      </section>
      ) : null}

      {!isNewMachineView && inactiveAgents.length > 0 && selectedAgent?.connectionState === "connected" ? (
        <details className={`${cardShell} p-5`}>
          <summary className="cursor-pointer text-[13px] font-semibold text-[var(--color-text-primary)]">
            Show {inactiveAgents.length} inactive machine{inactiveAgents.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-4 grid gap-3">
            {inactiveAgents.map((agent) => (
              <MachineRow
                key={agent.agentId}
                agent={agent}
                jobs={overview.jobs.filter((job) => job.agentId === agent.agentId)}
                serverOrigin={browserOrigin}
                onRefresh={refreshOverview}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function _MachineAuthConnectors({
  agent,
  onRefresh,
}: {
  agent: RemoteAgentSummary;
  onRefresh: () => Promise<void>;
}) {
  const [copiedConnector, setCopiedConnector] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const reported = agent.authConnectors ?? [];
  const github = reported.find((connector) => connector.connectorId === "github-cli");
  const connectors: RemoteAuthConnectorSummary[] = [
    github ?? {
      connectorId: "github-cli",
      kind: "github",
      label: "GitHub CLI",
      status: "unknown",
      detail: "Waiting for the bridge to report gh auth status.",
      checkedAt: agent.lastSeenAt,
    },
    {
      connectorId: "npm",
      kind: "npm",
      label: "npm",
      status: "unknown",
      detail: "Coming next.",
      checkedAt: agent.lastSeenAt,
    },
    {
      connectorId: "docker",
      kind: "docker",
      label: "Docker",
      status: "unknown",
      detail: "Coming next.",
      checkedAt: agent.lastSeenAt,
    },
    {
      connectorId: "ssh",
      kind: "ssh",
      label: "SSH",
      status: "unknown",
      detail: "Coming next.",
      checkedAt: agent.lastSeenAt,
    },
  ];

  const launchGitHubJob = (action: "install" | "check" | "login") =>
    startTransition(() => {
      void (async () => {
        try {
          setActionError(null);
          setActionMessage(null);
          const command =
            action === "install"
              ? "set -e; if ! command -v gh >/dev/null 2>&1; then sudo apt update && sudo apt install -y gh; fi; gh auth status || gh auth login; gh auth status"
              : action === "login"
                ? "gh auth login; gh auth status"
                : "gh auth status";
          const result = await requestJson<{ job: RemoteAgentJob }>("/api/remote-agents/jobs", {
            method: "POST",
            body: JSON.stringify({
              agentId: agent.agentId,
              title:
                action === "install"
                  ? "Install GitHub CLI"
                  : action === "login"
                    ? "Login GitHub CLI"
                    : "Check GitHub CLI auth",
              command: ["bash", "-lc", command],
              cwd: agent.repoRoot || agent.worktree || "/tmp",
              env: {
                PI_REMOTE_INTERACTIVE: "1",
              },
            }),
          });
          setActionMessage(`${action === "install" ? "Install" : action === "login" ? "Login" : "Check"} job started.`);
          window.location.href = `/remote-sessions/${encodeURIComponent(result.job.jobId)}`;
        } catch (nextError) {
          setActionError(nextError instanceof Error ? nextError.message : "Failed to start connector job");
        }
      })();
    });

  return (
    <div className="mb-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Auth connectors
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            Local credentials this machine can use for agent work.
          </p>
        </div>
        <span className="rounded-full border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
          {reported.filter((connector) => connector.status === "connected").length} ready
        </span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {connectors.map((connector) => (
          <div
            key={connector.connectorId}
            className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
                {connector.label}
              </p>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${authTone(connector.status)}`}>
                {connector.status}
              </span>
            </div>
            <p className="mt-2 line-clamp-2 min-h-[32px] text-[11px] leading-4 text-[var(--color-text-secondary)]">
              {connector.account ? `${connector.account} · ` : ""}
              {connector.detail}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <AuthConnectorAction
                connectorId={connector.connectorId}
                status={connector.status}
                copiedConnector={copiedConnector}
                onCopied={setCopiedConnector}
                disabled={isPending || agent.connectionState !== "connected"}
                onRun={launchGitHubJob}
              />
              {connector.connectorId === "github-cli" ? (
                <button
                  type="button"
                  disabled={isPending || agent.connectionState !== "connected"}
                  onClick={() => launchGitHubJob("check")}
                  className="rounded-full border border-[var(--color-border-default)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Check now
                </button>
              ) : null}
              {connector.connectorId === "github-cli" ? (
                <button
                  type="button"
                  onClick={() => {
                    void copyText("gh auth status").then(() => setCopiedConnector("github-cli-check"));
                  }}
                  className="rounded-full border border-[var(--color-border-default)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)]"
                >
                  {copiedConnector === "github-cli-check" ? "Copied" : "Copy check"}
                </button>
              ) : (
                <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                  {authAction(connector.status)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      {actionMessage ? (
        <p className="mt-3 text-[11px] font-medium text-[var(--color-status-success)]">{actionMessage}</p>
      ) : null}
      {actionError ? (
        <p className="mt-3 text-[11px] font-medium text-[var(--color-accent-red)]">{actionError}</p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          void onRefresh();
        }}
        className="mt-3 rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]"
      >
        Refresh auth status
      </button>
      {github?.status === "disconnected" || github?.status === "missing" ? (
        <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-tertiary)]">
          GitHub credentials stay on this machine. PI only reads the status; agents can use `gh` after you log in locally.
        </p>
      ) : null}
    </div>
  );
}

function AuthConnectorAction({
  connectorId,
  status,
  copiedConnector,
  onCopied,
  disabled,
  onRun,
}: {
  connectorId: string;
  status: string;
  copiedConnector: string | null;
  onCopied: (value: string | null) => void;
  disabled: boolean;
  onRun: (action: "install" | "check" | "login") => void;
}) {
  if (connectorId !== "github-cli") return null;

  const command =
    status === "missing"
      ? "sudo apt update && sudo apt install -y gh"
      : status === "disconnected"
        ? "gh auth login"
        : status === "connected"
          ? "gh auth status"
          : "command -v gh && gh auth status";
  const label =
    status === "missing"
      ? "Copy install"
      : status === "disconnected"
        ? "Copy login"
        : status === "connected"
          ? "Copy status"
          : "Copy check";
  const key = `${connectorId}-${status}`;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (status === "missing") onRun("install");
          else if (status === "disconnected") onRun("login");
          else onRun("check");
        }}
        className="rounded-full bg-[var(--color-accent)] px-2 py-1 text-[10px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "missing" ? "Install" : status === "disconnected" ? "Login" : "Run check"}
      </button>
      <button
        type="button"
        onClick={() => {
          void copyText(command).then(() => onCopied(key));
        }}
        className="rounded-full border border-[var(--color-border-default)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-primary)]"
      >
        {copiedConnector === key ? "Copied" : label}
      </button>
    </>
  );
}

function MachineDetailsEditor({
  agent,
  onRefresh,
}: {
  agent: RemoteAgentSummary;
  onRefresh: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [projectLabel, setProjectLabel] = useState(agent.projectLabel);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setDisplayName(agent.displayName);
    setProjectLabel(agent.projectLabel);
  }, [agent.agentId, agent.displayName, agent.projectLabel]);

  const save = () =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          setMessage(null);
          await requestJson(`/api/remote-agents/agents/${encodeURIComponent(agent.agentId)}`, {
            method: "PATCH",
            body: JSON.stringify({ displayName, projectLabel }),
          });
          await onRefresh();
          setMessage("Machine details saved.");
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to update machine");
        }
      })();
    });

  return (
    <div className="mb-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-[220px] flex-1 gap-1">
          <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Machine name
          </label>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)]"
          />
        </div>
        <div className="grid min-w-[220px] flex-1 gap-1">
          <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Tag / label
          </label>
          <input
            value={projectLabel}
            onChange={(event) => setProjectLabel(event.currentTarget.value)}
            className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)]"
          />
        </div>
        <button
          type="button"
          disabled={isPending || !displayName.trim() || !projectLabel.trim()}
          onClick={save}
          className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          Save
        </button>
      </div>
      {message ? <p className="mt-3 text-[12px] font-medium text-[var(--color-status-success)]">{message}</p> : null}
      {error ? <p className="mt-3 text-[12px] font-medium text-[var(--color-accent-red)]">{error}</p> : null}
    </div>
  );
}

function MachineRow({
  agent,
  jobs,
  serverOrigin,
  onRefresh,
}: {
  agent: RemoteAgentSummary;
  jobs: RemoteAgentJob[];
  serverOrigin: string;
  onRefresh: () => Promise<void>;
}) {
  const [resumeMessage, setResumeMessage] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [copiedReconnect, setCopiedReconnect] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [reconnectCode, setReconnectCode] = useState<{ code: string; command: string; advancedCommand: string; relayUrl: string } | null>(null);
  const [copiedReconnectCode, setCopiedReconnectCode] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Session history is only populated for Codex sessions by pi-agent; use it directly.
  const codexSessions = agent.sessionHistory ?? [];
  const reconnect = reconnectCommand(agent, serverOrigin);
  const recentJobs = [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 5);
  const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "queued");

  const disconnectMachine = () =>
    startTransition(() => {
      void (async () => {
        try {
          setLifecycleError(null);
          await requestJson(`/api/remote-agents/agents/${encodeURIComponent(agent.agentId)}/disconnect`, { method: "POST" });
          await onRefresh();
        } catch (err) {
          setLifecycleError(err instanceof Error ? err.message : "Failed to disconnect");
        }
      })();
    });

  const forgetMachine = () =>
    startTransition(() => {
      void (async () => {
        try {
          setLifecycleError(null);
          if (activeJobs.length > 0) {
            const ok = window.confirm(
              `This machine has ${activeJobs.length} active job(s). They must be stopped first. Proceed anyway?`,
            );
            if (!ok) return;
          } else {
            const ok = window.confirm(
              `Forget "${agent.displayName}"? This removes the machine from PI. Session history is kept.`,
            );
            if (!ok) return;
          }
          await requestJson(`/api/remote-agents/agents/${encodeURIComponent(agent.agentId)}`, { method: "DELETE" });
          await onRefresh();
        } catch (err) {
          setLifecycleError(err instanceof Error ? err.message : "Failed to forget machine");
        }
      })();
    });

  const generateReconnectCode = () =>
    startTransition(() => {
      void (async () => {
        try {
          setLifecycleError(null);
          setCopiedReconnectCode(false);
          const result = await requestJson<{ enrollment: { code: string }; pairCommand: string; advancedCommand: string; relayUrl: string }>(
            `/api/remote-agents/agents/${encodeURIComponent(agent.agentId)}/reconnect`,
            { method: "POST" },
          );
          setReconnectCode({ code: result.enrollment.code, command: result.pairCommand, advancedCommand: result.advancedCommand, relayUrl: result.relayUrl });
          await onRefresh();
        } catch (err) {
          setLifecycleError(err instanceof Error ? err.message : "Failed to generate reconnect code");
        }
      })();
    });

  const pollResumeJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const nextOverview = await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview");
      const nextJob = nextOverview.jobs.find((job) => job.jobId === jobId);
      if (nextJob) {
        setResumeMessage(
          nextJob.status === "running"
            ? "Resume running in a remote terminal."
            : `Resume ${nextJob.status}${nextJob.exitCode !== undefined && nextJob.exitCode !== null ? ` (exit ${nextJob.exitCode})` : ""}.`,
        );
        if (nextJob.status !== "queued") {
          await onRefresh().catch(() => void 0);
          return;
        }
      }
    }
  };

  const resumeSession = (session: RemoteAgentSessionHistoryItem) =>
    startTransition(() => {
      void (async () => {
        try {
          setResumeError(null);
          setResumeMessage(null);
          setResumingSessionId(session.sessionId);
          const cwd = session.cwd || agent.worktree || agent.repoRoot;
          const result = await requestJson<{ job: RemoteAgentJob }>("/api/remote-agents/jobs", {
            method: "POST",
            body: JSON.stringify({
              agentId: agent.agentId,
              provider: "codex",
              providerArgs: ["resume", session.sessionId],
              cwd,
              title: `Resume Codex session: ${session.sessionId.slice(0, 8)}`,
              env: {
                PI_RESUME_SESSION_ID: session.sessionId,
                PI_RESUME_SESSION_PATH: session.path,
              },
            }),
          });
          setResumeMessage(`Resume ${result.job.status}. Waiting for the machine to pick it up...`);
          void pollResumeJob(result.job.jobId).catch((nextError) => {
            setResumeError(nextError instanceof Error ? nextError.message : "Failed to poll resume job");
          });
        } catch (nextError) {
          setResumeError(nextError instanceof Error ? nextError.message : "Failed to resume session");
        } finally {
          setResumingSessionId(null);
        }
      })();
    });

  return (
    <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-[var(--color-text-primary)]">
            {agent.displayName}
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            {agent.hostLabel} / last seen {formatRelativeTime(agent.lastSeenAt)}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${connectionTone(agent)}`}>
          {agent.connectionState}
        </span>
      </div>

      {agent.connectionState !== "connected" ? (
        <div className={`mt-3 rounded-2xl p-3 ${agent.connectionState === "disabled" ? "border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]" : "border border-[var(--color-accent-red)]/40 bg-[var(--color-bg-surface)]"}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[12px] font-semibold text-[var(--color-text-primary)]">
                {agent.connectionState === "disabled" ? "Machine paused in PI" : "This machine is offline"}
              </p>
              <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                {agent.connectionState === "disabled"
                  ? "PI will not dispatch new jobs. The daemon on the machine will stop automatically on its next heartbeat. Use Reconnect to re-pair."
                  : "Queued jobs and Resume will wait here until the bridge daemon reconnects on that machine."}
              </p>
            </div>
            {reconnect ? (
              <button
                type="button"
                onClick={() => {
                  void copyText(reconnect)
                    .then(() => setCopiedReconnect(true))
                    .catch((nextError) =>
                      setResumeError(nextError instanceof Error ? nextError.message : "Failed to copy reconnect command"),
                    );
                }}
                className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]"
              >
                {copiedReconnect ? "Copied" : "Copy reconnect"}
              </button>
            ) : null}
          </div>
          {reconnect ? (
            <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--color-bg-base)] px-3 py-2 text-[11px] leading-5 text-[var(--color-text-primary)]">
              {reconnect}
            </pre>
          ) : (
            <p className="mt-3 text-[12px] text-[var(--color-text-tertiary)]">
              Create a new connect code above, then run the pair command on this machine.
            </p>
          )}
        </div>
      ) : null}

      {recentJobs.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                Active remote sessions
              </p>
              <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                Work started from PI on this connected machine.
              </p>
            </div>
            <span className="rounded-full border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
              {recentJobs.length} job{recentJobs.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-3 grid gap-2">
            {recentJobs.map((job) => (
              <div
                key={job.jobId}
                className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
                      {job.title}
                    </p>
                    <p className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">
                      {job.cwd || agent.worktree || agent.repoRoot || "unknown cwd"}
                    </p>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${jobTone(job)}`}>
                    {job.status}
                  </span>
                </div>
                <p className="mt-2 truncate text-[11px] text-[var(--color-text-tertiary)]">
                  {job.command?.[1] === "claude" ? "Claude Code" : job.command?.[1] === "codex" ? "Codex" : job.command?.[1] ?? ""}
                  {" · "}Started {formatRelativeTime(job.startedAt ?? job.createdAt)}
                </p>
                {job.error ? (
                  <p className="mt-2 text-[11px] font-medium text-[var(--color-accent-red)]">
                    {job.error}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {codexSessions.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                Codex session history
              </p>
              <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                {codexSessions.length > 0
                  ? `${codexSessions.length} recent session${codexSessions.length === 1 ? "" : "s"} from ~/.codex/sessions`
                  : "No Codex sessions reported yet"}
              </p>
            </div>
          </div>
          {codexSessions.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {codexSessions.slice(0, 6).map((session) => (
                <div
                  key={`${agent.agentId}-${session.sessionId}-${session.path}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-[12px] font-semibold leading-5 text-[var(--color-text-primary)]">
                      {session.messagePreview || "No human task captured"}
                    </p>
                    {session.lastActivityPreview ? (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                        Last: {session.lastActivityPreview}
                      </p>
                    ) : null}
                    <p className="mt-1 truncate text-[11px] text-[var(--color-text-tertiary)]">
                      {shortSessionId(session.sessionId)} / {folderName(session.cwd || agent.worktree || agent.repoRoot)} / updated{" "}
                      {formatRelativeTime(session.updatedAt)}
                    </p>
                    <p className="mt-1 truncate text-[11px] text-[var(--color-text-tertiary)]">
                      {session.source || "codex"}{session.cliVersion ? ` ${session.cliVersion}` : ""}
                      {session.model ? ` / ${session.model}` : ""}
                      {typeof session.eventCount === "number" ? ` / ${session.eventCount} events` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isPending || agent.connectionState !== "connected"}
                    onClick={() => resumeSession(session)}
                    className="rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {resumingSessionId === session.sessionId ? "Resuming..." : "Resume"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {resumeMessage ? (
            <p className="mt-3 text-[12px] font-medium text-[var(--color-status-success)]">
              {resumeMessage}
            </p>
          ) : null}
          {resumeError ? (
            <p className="mt-3 text-[12px] font-medium text-[var(--color-accent-red)]">
              {resumeError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── Machine lifecycle controls ─────────────────────────────── */}
      <div className="mt-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Machine controls
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {agent.connectionState !== "disabled" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={disconnectMachine}
              title="Stops PI from dispatching new jobs. The daemon on the machine will exit on its next heartbeat."
              className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-status-attention)] hover:text-[var(--color-status-attention)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Pause
            </button>
          ) : null}
          <button
            type="button"
            disabled={isPending}
            onClick={generateReconnectCode}
            className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reconnect
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={forgetMachine}
            className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent-red)] hover:text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Forget machine
          </button>
        </div>

        {reconnectCode ? (
          <div className="mt-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  One-time reconnect code
                </p>
                <p className="mt-0.5 text-[16px] font-semibold tracking-[0.1em] text-[var(--color-text-primary)]">
                  {reconnectCode.code}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  void copyText(reconnectCode.command)
                    .then(() => setCopiedReconnectCode(true))
                    .catch(() => void 0);
                }}
                className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]"
              >
                {copiedReconnectCode ? "Copied" : "Copy command"}
              </button>
            </div>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-5 text-[var(--color-text-primary)]">
              {reconnectCode.command}
            </pre>
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
                Advanced — with terminal relay URL
              </summary>
              <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                Use this if the live terminal (DirectTerminal) is not connecting.
                Relay: <span className="font-mono">{reconnectCode.relayUrl}</span>
              </p>
              <pre className="mt-1 overflow-x-auto rounded-lg bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-5 text-[var(--color-text-primary)]">
                {reconnectCode.advancedCommand}
              </pre>
            </details>
          </div>
        ) : null}

        {lifecycleError ? (
          <p className="mt-3 text-[12px] font-medium text-[var(--color-accent-red)]">{lifecycleError}</p>
        ) : null}
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
