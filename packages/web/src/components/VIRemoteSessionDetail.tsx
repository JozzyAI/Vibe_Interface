"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteAgentEvent,
  RemoteAgentJob,
  RemoteAgentSummary,
  RemoteApprovalOverview,
  RemoteApprovalRequest,
} from "@/lib/types";
import Link from "next/link";
import { DirectTerminal } from "./DirectTerminal";
import { RemoteLogTerminal } from "./RemoteLogTerminal";

interface Props {
  jobId: string;
  initialOverview: RemoteApprovalOverview;
}

// ---------------------------------------------------------------------------
// Approval request card with optional timeout_allow countdown
// ---------------------------------------------------------------------------

function ApprovalRequestCard({
  request,
  agent,
  onRespond,
}: {
  request: RemoteApprovalRequest;
  agent: RemoteAgentSummary | undefined;
  onRespond: (action: "approve" | "reject") => void;
}) {
  const isTimeout = agent?.permissionMode === "timeout_allow";
  const timeoutSeconds = agent?.timeoutSeconds ?? 10;

  const calcRemaining = () => {
    const elapsedMs = Date.now() - new Date(request.createdAt).getTime();
    return Math.max(0, Math.ceil(timeoutSeconds - elapsedMs / 1000));
  };

  const [remaining, setRemaining] = useState<number>(calcRemaining);

  useEffect(() => {
    if (!isTimeout) return;
    const id = setInterval(() => setRemaining(calcRemaining()), 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTimeout, request.createdAt, timeoutSeconds]);

  // fraction 1 → 0 as time elapses
  const progress = isTimeout ? remaining / timeoutSeconds : 1;

  return (
    <article className="rounded-2xl bg-[var(--color-bg-surface)] p-4">
      <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
        {request.title}
      </h2>
      <p className="mt-2 text-[13px] leading-7 text-[var(--color-text-secondary)]">
        {request.message}
      </p>
      {request.command ? (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--color-bg-base)] px-3 py-2 text-[12px] leading-6 text-[var(--color-text-primary)]">
          {request.command}
        </pre>
      ) : null}

      {isTimeout ? (
        <div className="mt-3">
          {/* thin progress bar — drains left to right */}
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--color-bg-base)]">
            <div
              className="h-full rounded-full bg-[var(--color-status-attention)]/50 transition-[width] duration-500 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--color-text-secondary)]">
            {remaining > 0 ? `Auto-approving in ${remaining}s` : "Auto-approving…"}
          </p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onRespond("approve")}
          className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onRespond("reject")}
          className="rounded-full border border-[var(--color-border-subtle)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)]"
        >
          {isTimeout ? "Cancel" : "Reject"}
        </button>
      </div>
    </article>
  );
}

const SHOW_HANDOFF_CONTROLS = false;

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

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(diffMinutes)) return "unknown";
  if (diffMinutes < -60) return `in ${Math.ceil(Math.abs(diffMinutes) / 60)}h`;
  if (diffMinutes < -1) return `in ${Math.abs(diffMinutes)}m`;
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function remoteEventLabel(event: RemoteAgentEvent): string {
  const metadata = event.metadata ?? {};
  switch (event.type) {
    case "session.created":
      return metadata.source ? `Session created by ${metadata.source}` : "Session created";
    case "session.status_changed":
      return metadata.to ? `Status changed to ${metadata.to}` : "Status changed";
    case "session.provider_state_changed":
      return metadata.to ? `Agent state changed to ${metadata.to}` : "Agent state changed";
    case "session.input_queued":
      return "Input queued";
    case "session.restarted":
      return event.severity === "attention" ? "Restart needed" : "Restart queued";
    case "session.continued":
      return "Continued on another machine";
    case "session.auto_resume_queued":
      return "Auto-resume queued";
    case "session.ralph_iteration_queued":
      return "Ralph iteration queued";
    case "session.archived":
      return "Session archived";
    case "approval.requested":
      return metadata.title ? `Approval requested: ${metadata.title}` : "Approval requested";
    case "approval.decided":
      return metadata.action ? `Approval ${metadata.action}` : "Approval decided";
    case "policy.updated":
      return metadata.policy ? `Policy updated: ${metadata.policy}` : "Policy updated";
    case "machine.connected":
      return "Machine connected";
    case "machine.disconnected":
      return "Machine disconnected";
    case "machine.updated":
      return "Machine updated";
    case "machine.daemon_restart_requested":
      return "Daemon restart requested";
    case "machine.registered":
      return "Machine registered";
    default:
      return event.type.replaceAll(".", " ");
  }
}

function statusTone(status: string): string {
  if (status === "running" || status === "connected") return "border-[var(--color-status-ok)] text-[var(--color-status-ok)]";
  if (status === "queued" || status === "stale" || status === "restart required" || status === "degraded") {
    return "border-[var(--color-status-attention)] text-[var(--color-status-attention)]";
  }
  if (status === "failed" || status === "disconnected") return "border-[var(--color-accent-red)] text-[var(--color-accent-red)]";
  return "border-[var(--color-border-default)] text-[var(--color-text-secondary)]";
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

function optionLabelFromLine(line: string): string {
  return line
    .replace(/^\s*[â€º>â€¢*-]?\s*\d+[.)]\s+/, "")
    .replace(/\s{2,}.+$/, "")
    .trim();
}

function detectNumberedCliChoice(lines: string[]): {
  title: string;
  message: string;
  actions: Array<{
    label: string;
    input: string;
    tone?: "primary" | "danger" | "secondary";
  }>;
} | null {
  const recentLines = lines.slice(-48);
  const recentText = recentLines.join("\n").toLowerCase();
  const isWaitingForChoice =
    /press enter to (confirm|continue)/i.test(recentText) ||
    /choose (one|an) option/i.test(recentText) ||
    /select (one|an) option/i.test(recentText);
  if (!isWaitingForChoice) return null;

  const lastUpdateMenuAt = recentText.lastIndexOf("update available");
  const lastUpdateFinishedAt = Math.max(
    recentText.lastIndexOf("update ran successfully"),
    recentText.lastIndexOf("please restart codex"),
  );
  if (lastUpdateMenuAt >= 0 && lastUpdateFinishedAt > lastUpdateMenuAt) return null;

  const optionLines = recentLines
    .map((line) => {
      const match = line.match(/^\s*[â€º>â€¢*-]?\s*(\d+)[.)]\s+(.+)$/);
      if (!match) return null;
      const label = optionLabelFromLine(line);
      if (!label) return null;
      return { input: match[1], label };
    })
    .filter((option): option is { input: string; label: string } => Boolean(option));

  const uniqueOptions = optionLines.filter(
    (option, index, all) => all.findIndex((candidate) => candidate.input === option.input) === index,
  );
  if (uniqueOptions.length < 2) return null;

  const isRateLimitModelChoice =
    recentText.includes("approaching rate limits") ||
    recentText.includes("switch to") ||
    recentText.includes("lower credit usage");
  const isUpdatePrompt =
    recentText.includes("update available") &&
    uniqueOptions.some((option) => option.label.toLowerCase().includes("update now"));

  return {
    title: isRateLimitModelChoice
      ? "Codex model choice"
      : isUpdatePrompt
        ? "Codex update prompt"
        : "CLI is waiting for a choice",
    message: isRateLimitModelChoice
      ? "Codex is asking whether to switch models before continuing. Choose one option and VI will send it to the remote CLI."
      : isUpdatePrompt
        ? "Codex is asking whether to update before continuing. Choose one option and VI will send it to the remote CLI."
        : "The remote CLI is paused at a numbered choice. Choose one option and VI will send it to the remote CLI.",
    actions: uniqueOptions.map((option, index) => {
      const lower = option.label.toLowerCase();
      return {
        label: option.label,
        input: option.input,
        tone:
          lower.includes("quit") || lower.includes("reject") || lower.includes("no")
            ? "danger"
            : index === 0
              ? "primary"
              : "secondary",
      };
    }),
  };
}

function detectCliApproval(logTail: string | undefined): {
  title: string;
  message: string;
  actions: Array<{
    label: string;
    input: string;
    tone?: "primary" | "danger" | "secondary";
  }>;
} | null {
  const clean = stripAnsi(logTail ?? "");
  if (!clean) return null;
  const lines = clean.split(/\r?\n/);
  const fullText = clean.toLowerCase();
  const recent = lines.slice(-18).join("\n").toLowerCase();

  const numberedChoice = detectNumberedCliChoice(lines);
  if (numberedChoice) return numberedChoice;

  const lastUpdateMenuAt = fullText.lastIndexOf("update available");
  const lastUpdateFinishedAt = Math.max(
    fullText.lastIndexOf("update ran successfully"),
    fullText.lastIndexOf("please restart codex"),
  );
  if (
    lastUpdateMenuAt >= 0 &&
    lastUpdateFinishedAt < lastUpdateMenuAt &&
    fullText.includes("update now") &&
    fullText.includes("skip until next version")
  ) {
    return {
      title: "Codex update prompt",
      message: "Codex is asking whether to update before continuing. Choose one option and VI will send it to the remote CLI.",
      actions: [
        { label: "Update now", input: "1", tone: "primary" },
        { label: "Skip", input: "2", tone: "secondary" },
        { label: "Skip until next version", input: "3", tone: "secondary" },
      ],
    };
  }
  if (recent.includes("do you trust the contents of this directory")) {
    return {
      title: "Codex needs directory trust approval",
      message:
        "Codex is paused before working in this directory because untrusted repo contents can contain prompt injection.",
      actions: [
        { label: "Yes, continue", input: "1", tone: "primary" },
        { label: "No, quit", input: "2", tone: "danger" },
      ],
    };
  }
  if (recent.includes("press enter to continue")) {
    return {
      title: "CLI is waiting for Enter",
      message: "The remote CLI is paused at a confirmation screen.",
      actions: [{ label: "Press Enter", input: "", tone: "primary" }],
    };
  }
  return null;
}

function preferredAutoApprovalAction(
  approval: NonNullable<ReturnType<typeof detectCliApproval>>,
): NonNullable<ReturnType<typeof detectCliApproval>>["actions"][number] | undefined {
  const title = approval.title.toLowerCase();
  if (title.includes("model choice")) {
    return (
      approval.actions.find((action) => action.label.toLowerCase().includes("keep current model")) ??
      approval.actions.find((action) => action.tone !== "danger")
    );
  }
  if (title.includes("update prompt")) {
    return (
      approval.actions.find((action) => action.label.toLowerCase() === "skip") ??
      approval.actions.find((action) => action.tone !== "danger")
    );
  }
  const positive = approval.actions.find((action) => {
    const label = action.label.toLowerCase();
    if (action.tone === "danger") return false;
    return (
      label.includes("always") ||
      label.includes("approve") ||
      label.includes("allow") ||
      label.includes("yes") ||
      label.includes("continue")
    );
  });
  if (positive) return positive;
  return approval.actions.find((action) => action.tone !== "danger");
}

function containsUsageLimit(logTail: string | undefined, error: string | undefined): boolean {
  const lower = `${error ?? ""}\n${logTail ?? ""}`.toLowerCase();
  return lower.includes("usage limit") || lower.includes("you've hit your usage limit");
}

function needsCodexRestart(logTail: string | undefined): boolean {
  return (logTail ?? "").toLowerCase().includes("please restart codex");
}

function compactMarkdownPreview(text: string | undefined): string {
  const clean = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean;
}

function hasUnsupportedModelError(logTail: string | undefined, error: string | undefined): boolean {
  const lower = `${error ?? ""}\n${logTail ?? ""}`.toLowerCase();
  return (
    lower.includes("model is not supported") ||
    lower.includes("unsupported model") ||
    lower.includes("requires a newer version of codex") ||
    lower.includes("please upgrade to the latest app or cli")
  );
}

function hasProviderHeartbeatFailure(logTail: string | undefined, error: string | undefined): boolean {
  const lower = `${error ?? ""}\n${logTail ?? ""}`.toLowerCase();
  if (!lower.includes("provider_heartbeat_failed")) return false;
  return !lower.includes("gpt-5") && !lower.includes("openai codex");
}

function isCodexIdlePrompt(logTail: string | undefined): boolean {
  const clean = stripAnsi(logTail ?? "").toLowerCase();
  if (!clean) return false;
  if (!clean.includes("gpt-5") && !clean.includes("openai codex")) return false;
  const lastLines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
  return lastLines.includes("gpt-5") && !lastLines.includes("thinking");
}

const CODEX_MODEL_OPTIONS = [
  { value: "", label: "Codex default" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { value: "gpt-5.2", label: "gpt-5.2" },
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
  { value: "gpt-5-codex", label: "gpt-5-codex" },
  { value: "gpt-5.2-pro", label: "gpt-5.2-pro" },
  { value: "gpt-5-mini", label: "gpt-5-mini" },
  { value: "__custom", label: "Custom model..." },
];

const CLAUDE_MODEL_OPTIONS = [
  { value: "", label: "Default (uses VI_CLAUDE_DEFAULT_MODEL if set)" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
  { value: "__custom", label: "Custom..." },
];

const REASONING_OPTIONS = [
  { value: "", label: "Default thinking" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

export function VIRemoteSessionDetail({ jobId, initialOverview }: Props) {
  const [overview, setOverview] = useState(initialOverview);
  const [error, setError] = useState<string | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [isSendingInput, setIsSendingInput] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRestartingDaemon, setIsRestartingDaemon] = useState(false);
  const [updatingSetting, setUpdatingSetting] = useState<"ralph" | "usage" | "restart" | null>(null);
  const autoApprovalSentRef = useRef<string | null>(null);

  const job = useMemo<RemoteAgentJob | undefined>(
    () => overview.jobs.find((entry) => entry.jobId === jobId),
    [jobId, overview.jobs],
  );
  const agent = useMemo<RemoteAgentSummary | undefined>(
    () => overview.agents.find((entry) => entry.agentId === job?.agentId),
    [job?.agentId, overview.agents],
  );
  const requests = useMemo<RemoteApprovalRequest[]>(
    () =>
      overview.requests.filter(
        (request) => request.agentId === job?.agentId && request.status === "open",
      ),
    [job?.agentId, overview.requests],
  );
  const utilityRequests = useMemo<RemoteApprovalRequest[]>(
    () =>
      overview.requests.filter(
        (request) => request.agentId === job?.agentId && request.parentJobId === job?.jobId,
      ),
    [job?.agentId, job?.jobId, overview.requests],
  );
  const utilityJobs = useMemo<RemoteAgentJob[]>(
    () =>
      overview.jobs.filter(
        (entry) =>
          entry.parentJobId === job?.jobId ||
          utilityRequests.some((request) => request.createdJobId === entry.jobId),
      ),
    [job?.jobId, overview.jobs, utilityRequests],
  );
  const detectedCliApproval = useMemo(
    () => detectCliApproval(job?.logTail),
    [job?.logTail],
  );
  const usageLimitDetected = useMemo(
    () => containsUsageLimit(job?.logTail, job?.error),
    [job?.error, job?.logTail],
  );
  const codexRestartRequired = useMemo(
    () => needsCodexRestart(job?.logTail) || hasUnsupportedModelError(job?.logTail, job?.error),
    [job?.error, job?.logTail],
  );
  const providerHeartbeatFailed = useMemo(
    () => hasProviderHeartbeatFailure(job?.logTail, job?.error),
    [job?.error, job?.logTail],
  );
  const codexIdlePrompt = useMemo(
    () => job?.status === "running" && isCodexIdlePrompt(job?.logTail),
    [job?.logTail, job?.status],
  );
  const effectiveStatus = codexRestartRequired
    ? "restart required"
    : providerHeartbeatFailed
      ? "degraded"
      : codexIdlePrompt
        ? "idle"
        : job?.status;
  const canSendInput =
    job?.status === "running" &&
    agent?.connectionState === "connected" &&
    !codexRestartRequired &&
    !providerHeartbeatFailed;

  useEffect(() => {
    const interval = setInterval(() => {
      void requestJson<RemoteApprovalOverview>("/api/remote-agents/overview")
        .then(setOverview)
        .catch((nextError) =>
          setError(nextError instanceof Error ? nextError.message : "Failed to refresh remote session"),
        );
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const respond = async (request: RemoteApprovalRequest, action: "approve" | "reject") => {
    await requestJson("/api/remote-agents/requests/respond", {
      method: "POST",
      body: JSON.stringify({ requestId: request.requestId, action }),
    });
    setOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
  };

  const sendTerminalInput = async (
    text: string,
    submit = true,
    key?: "escape",
  ) => {
    if (!job || !agent || (key !== "escape" && !text && !submit) || !canSendInput) return;
    setIsSendingInput(true);
    setError(null);
    try {
      await requestJson("/api/remote-agents/jobs/input", {
        method: "POST",
        body: JSON.stringify({
          agentId: agent.agentId,
          jobId: job.jobId,
          text,
          submit,
          key,
        }),
      });
      setTerminalInput("");
      setOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send remote input");
    } finally {
      setIsSendingInput(false);
    }
  };

  useEffect(() => {
    if (!job || !agent || !detectedCliApproval || !canSendInput || isSendingInput) return;
    if (agent.permissionMode === "manual") return;
    // Key injection is for Codex prompts only — Claude handles approvals natively (or via --dangerously-skip-permissions)
    if (job.command?.[1]?.toLowerCase() === "claude") return;
    const action = preferredAutoApprovalAction(detectedCliApproval);
    if (!action) return;
    const approvalKey = [
      job.jobId,
      detectedCliApproval.title,
      detectedCliApproval.actions.map((entry) => `${entry.input}:${entry.label}`).join("|"),
    ].join("::");
    if (autoApprovalSentRef.current === approvalKey) return;

    const delayMs = agent.permissionMode === "timeout_allow" ? agent.timeoutSeconds * 1000 : 0;
    const timeout = window.setTimeout(() => {
      autoApprovalSentRef.current = approvalKey;
      void sendTerminalInput(action.input, true);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [agent, canSendInput, detectedCliApproval, isSendingInput, job]);

  const archiveSession = async () => {
    if (!job) return;
    const confirmed = window.confirm(
      "Archive this session? It will be hidden from the Sessions list, but logs and history will stay on disk.",
    );
    if (!confirmed) return;
    setIsArchiving(true);
    setError(null);
    try {
      await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/archive`, {
        method: "POST",
        body: JSON.stringify({ agentId: job.agentId }),
      });
      window.location.href = "/sessions";
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to archive remote session");
      setIsArchiving(false);
    }
  };

  const removeSession = async () => {
    if (!job) return;
    const confirmed = window.confirm(
      "Remove this session from VI? This clears the session record and related VI requests. Logs may still exist on the machine.",
    );
    if (!confirmed) return;
    setIsRemoving(true);
    setError(null);
    try {
      await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/delete`, {
        method: "POST",
        body: JSON.stringify({ agentId: job.agentId }),
      });
      window.location.href = "/sessions";
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to remove remote session");
      setIsRemoving(false);
    }
  };

  const restartAndResume = async () => {
    if (!job || !agent) return;
    setIsRestarting(true);
    setError(null);
    try {
      const response = await requestJson<{ job: RemoteAgentJob }>(
        `/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/restart`,
        {
          method: "POST",
          body: JSON.stringify({ agentId: agent.agentId }),
        },
      );
      window.location.href = `/remote-sessions/${encodeURIComponent(response.job.jobId)}`;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to restart remote session");
      setIsRestarting(false);
    }
  };

  const updateJobSetting = async (
    next: Pick<RemoteAgentJob, "ralphEnabled" | "autoResumeUsageLimit" | "autoRestartCodex">,
    setting: "ralph" | "usage" | "restart",
  ) => {
    if (!job || !agent) return;
    setUpdatingSetting(setting);
    setError(null);
    try {
      await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          agentId: agent.agentId,
          ...next,
        }),
      });
      setOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update session setting");
    } finally {
      setUpdatingSetting(null);
    }
  };

  const approvalActionClass = (
    tone: "primary" | "danger" | "secondary" | undefined,
  ): string =>
    [
      "rounded-full px-4 py-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
      tone === "danger"
        ? "border border-[#fca5a5] bg-[#fff5f5] text-[#dc2626] hover:bg-[#fee2e2]"
        : tone === "secondary"
          ? "border border-[#c7d2fe] bg-[#f0f4ff] text-[#3730a3] hover:bg-[#e0e7ff]"
          : "border border-[#6f7bff] bg-[#5964d8] text-white hover:bg-[#6873ee]",
    ].join(" ");

  const approvalActionButtons = detectedCliApproval?.actions.map((action) => (
    <button
      key={`${action.label}-${action.input}`}
      type="button"
      disabled={isSendingInput || !canSendInput}
      onClick={() => void sendTerminalInput(action.input, true)}
      className={approvalActionClass(action.tone)}
    >
      {action.label}
    </button>
  ));
  // Derive provider from the actual job command (reliable), not agent enrollment toolType
  const jobProvider = job?.command?.[1]?.toLowerCase() ?? "unknown";
  const isCodexJob = jobProvider === "codex";
  const isClaudeJob = jobProvider === "claude";
  // Use DirectTerminal for any job that has a tmux session (both Codex and Claude Code)
  const liveTmuxSession = job?.tmuxSession ?? undefined;

  if (!job || !agent) {
    return (
      <div className="rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6">
        <h1 className="text-[24px] font-semibold text-[var(--color-text-primary)]">Remote session not found</h1>
        <Link href="/sessions" className="mt-4 inline-flex rounded-full border px-4 py-2 text-[12px] font-semibold hover:no-underline">
          Back to Sessions
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto grid min-w-0 max-w-[1120px] gap-5">
      <section className="hidden min-w-0 rounded-[2rem] border border-[var(--color-border-default)] bg-[radial-gradient(circle_at_top_left,rgba(97,102,204,0.15),transparent_34%),var(--color-bg-surface)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link href="/sessions" className="text-[12px] font-medium text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:no-underline">
              Back to Sessions
            </Link>
            <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Remote CLI session / {agent.displayName}
            </p>
            <h1 className="mt-2 max-w-5xl text-[30px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
              {job.title}
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${statusTone(effectiveStatus ?? "unknown")}`}>
              {effectiveStatus}
            </span>
            <span className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${statusTone(agent.connectionState)}`}>
              {agent.connectionState}
            </span>
            <button
              type="button"
              disabled={isArchiving}
              onClick={() => void archiveSession()}
              className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent-red)] hover:text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isArchiving ? "Archiving..." : `Archive ${job.jobId.replace(/^raj_/, "").slice(0, 8)}`}
            </button>
            <button
              type="button"
              disabled={isRemoving}
              onClick={() => void removeSession()}
              className="rounded-full border border-[var(--color-accent-red)]/50 px-3 py-1.5 text-[12px] font-semibold text-[var(--color-accent-red)] hover:bg-[var(--color-accent-red-soft)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRemoving ? "Removing..." : "Remove"}
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red-soft)] p-3 text-[13px] text-[var(--color-accent-red)]">
            {error}
          </div>
        ) : null}

        <div className="mt-5 grid gap-3 rounded-3xl bg-[var(--color-bg-base)] p-4 text-[13px] leading-6 text-[var(--color-text-secondary)] md:grid-cols-2">
          <p className="truncate">Command: {job.command.join(" ")}</p>
          <p className="truncate">CWD: {job.cwd ?? agent.worktree ?? agent.repoRoot ?? "unknown"}</p>
          <p className="truncate">Host: {agent.hostLabel}</p>
          <p>Updated {formatRelativeTime(job.updatedAt)}</p>
          <p>Ralph mode: {job.ralphEnabled ? "iteration" : "off"}</p>
          <p>Usage-limit auto resume: {job.autoResumeUsageLimit ? "enabled" : "off"}</p>
          {isCodexJob ? <p>Codex auto restart: {job.autoRestartCodex ? "enabled" : "off"}</p> : null}
          {job.restartedAsJobId ? (
            <p className="truncate">
              Restarted as: {job.restartedAsJobId.replace(/^raj_/, "").slice(0, 8)}
            </p>
          ) : null}
          {job.nextResumeAt ? <p className="md:col-span-2">Next auto resume: {formatRelativeTime(job.nextResumeAt)}</p> : null}
          {job.logFile ? <p className="truncate md:col-span-2">Log: {job.logFile}</p> : null}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <button
            type="button"
            disabled={updatingSetting !== null}
            onClick={() =>
              void updateJobSetting({ ralphEnabled: !job.ralphEnabled }, "ralph")
            }
            className={[
              "rounded-3xl border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
              job.ralphEnabled
                ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                : "border-[var(--color-border-default)] bg-[var(--color-bg-base)]",
            ].join(" ")}
          >
            <span className="block text-[12px] font-semibold text-[var(--color-text-primary)]">
              {job.ralphEnabled ? "Ralph iterations enabled" : "Enable Ralph iterations"}
            </span>
            <span className="mt-1 block text-[12px] leading-5 text-[var(--color-text-secondary)]">
              Start a fresh bounded follow-up job after this one exits with CONTINUE.
            </span>
          </button>

          <button
            type="button"
            disabled={updatingSetting !== null}
            onClick={() =>
              void updateJobSetting({ autoResumeUsageLimit: !job.autoResumeUsageLimit }, "usage")
            }
            className={[
              "rounded-3xl border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
              job.autoResumeUsageLimit
                ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                : "border-[var(--color-border-default)] bg-[var(--color-bg-base)]",
            ].join(" ")}
          >
            <span className="block text-[12px] font-semibold text-[var(--color-text-primary)]">
              {job.autoResumeUsageLimit ? "Usage-limit auto resume enabled" : "Enable auto resume after usage limit"}
            </span>
            <span className="mt-1 block text-[12px] leading-5 text-[var(--color-text-secondary)]">
              If Codex reports a usage limit, VI queues a follow-up run for the retry window.
            </span>
          </button>

          {isCodexJob ? (
            <button
              type="button"
              disabled={updatingSetting !== null}
              onClick={() =>
                void updateJobSetting({ autoRestartCodex: !job.autoRestartCodex }, "restart")
              }
              className={[
                "rounded-3xl border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                job.autoRestartCodex
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                  : "border-[var(--color-border-default)] bg-[var(--color-bg-base)]",
              ].join(" ")}
            >
              <span className="block text-[12px] font-semibold text-[var(--color-text-primary)]">
                {job.autoRestartCodex ? "Codex auto restart enabled" : "Enable Codex auto restart"}
              </span>
              <span className="mt-1 block text-[12px] leading-5 text-[var(--color-text-secondary)]">
                If Codex says restart is required, VI starts a fresh process and resumes the session.
              </span>
            </button>
          ) : null}
        </div>

        {usageLimitDetected ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-status-attention)]/40 bg-[var(--color-status-attention-soft)] p-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
            Usage limit detected in this session.{" "}
            {job.autoResumeUsageLimit
              ? "Auto-resume is enabled, so VI will schedule a follow-up run."
              : "Turn on auto-resume if you want VI to retry automatically later."}
          </div>
        ) : null}

        {isCodexJob && codexRestartRequired ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-status-attention)]/40 bg-[var(--color-status-attention-soft)] p-4 text-[13px] leading-6 text-[var(--color-text-secondary)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-[var(--color-text-primary)]">
                  Codex needs a restart before it can keep working.
                </p>
                <p className="mt-1">
                  The terminal may still echo input, but the actual agent loop is stale. Restart will launch a fresh
                  Codex process and resume the nearest saved Codex session from this machine.
                </p>
              </div>
              <button
                type="button"
                disabled={isRestarting}
                onClick={() => void restartAndResume()}
                className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isRestarting ? "Restarting..." : "Restart and resume"}
              </button>
            </div>
          </div>
        ) : null}

        {!codexRestartRequired && providerHeartbeatFailed ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-status-attention)]/40 bg-[var(--color-status-attention-soft)] p-4 text-[13px] leading-6 text-[var(--color-text-secondary)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-[var(--color-text-primary)]">
                  This terminal is degraded, not truly healthy.
                </p>
                <p className="mt-1">
                  VI detected provider heartbeat failures in the live log, so text may be delivered to tmux while the
                  actual Codex agent loop is no longer connected. Restarting will resume the nearest saved Codex session
                  in a fresh process.
                </p>
              </div>
              <button
                type="button"
                disabled={isRestarting}
                onClick={() => void restartAndResume()}
                className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isRestarting ? "Restarting..." : "Restart and resume"}
              </button>
            </div>
          </div>
        ) : null}

        {!canSendInput && job.status === "completed" ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-status-success)]/30 bg-[var(--color-status-success-soft)] p-4 text-[13px] leading-6">
            <p className="font-semibold text-[var(--color-status-success)]">Session completed</p>
            <p className="mt-1 text-[var(--color-text-secondary)]">
              Claude finished this task and exited. The terminal output above is read-only.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isArchiving || isRemoving}
                onClick={() => void archiveSession()}
                className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isArchiving ? "Archiving…" : "Archive session"}
              </button>
              <button
                type="button"
                disabled={isArchiving || isRemoving}
                onClick={() => void removeSession()}
                className="rounded-full border border-[var(--color-status-danger)]/30 bg-transparent px-3 py-1.5 text-[12px] font-medium text-[var(--color-status-danger)] hover:bg-[var(--color-status-danger)]/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isRemoving ? "Removing…" : "Delete session"}
              </button>
            </div>
          </div>
        ) : !canSendInput ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
            This session is not accepting input right now.{" "}
            {job.status !== "running"
              ? `The job is ${job.status}, so its terminal process has ended.`
              : codexRestartRequired
                ? "Codex asked for a restart, so VI is blocking manual input to avoid sending text into a stale process."
                : providerHeartbeatFailed
                  ? "The provider heartbeat is failing, so VI is blocking input instead of pretending the agent is connected."
                  : `The machine is ${agent.connectionState}.`}
            {" "}Open a running session from the sidebar, or start a new session.
          </div>
        ) : null}
      </section>

      {requests.length > 0 ? (
        <section className="rounded-3xl border border-[var(--color-status-attention)]/40 bg-[var(--color-status-attention-soft)] p-5">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-status-attention)]">
            Approval request
          </p>
          <div className="mt-3 grid gap-3">
            {requests.map((request) => (
              <ApprovalRequestCard
                key={request.requestId}
                request={request}
                agent={agent}
                onRespond={(action) => void respond(request, action)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {utilityJobs.length > 0 ? (
        <section className="rounded-3xl border border-[#cfd3ff] bg-[#f7f7ff] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5964d8]">
                Utility session
              </p>
              <h2 className="mt-1 text-[16px] font-semibold text-[#1e2026]">
                VI created a helper session
              </h2>
            </div>
            <span className="rounded-full border border-[#cfd3ff] bg-white px-3 py-1 text-[12px] font-semibold text-[#5964d8]">
              {utilityJobs.length} linked
            </span>
          </div>
          <div className="mt-3 grid gap-2">
            {utilityJobs.slice(0, 3).map((utilityJob) => (
              <a
                key={utilityJob.jobId}
                href={`/remote-sessions/${encodeURIComponent(utilityJob.jobId)}`}
                className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-[13px] hover:no-underline"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-[#1e2026]">
                    {utilityJob.title}
                  </span>
                  <span className="block text-[12px] text-[#737882]">
                    {utilityJob.status} - {formatRelativeTime(utilityJob.updatedAt)}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-[#1a1918] px-3 py-1.5 text-[12px] font-semibold text-white">
                  Open
                </span>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="min-w-0 overflow-hidden rounded-2xl border border-[#161820] bg-[#05060a] shadow-[0_24px_70px_rgba(0,0,0,0.18)]">
        <div className="flex h-10 items-center justify-between border-b border-[#171923] bg-[#0b0d13] px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[12px] font-medium text-[#8f98aa]">
              {agent.displayName} / {job.title}
            </span>
          </div>
          <span className="shrink-0 text-[11px] text-[#667085]">
            live - refreshes ~0.5s
          </span>
        </div>
        {detectedCliApproval ? (
          <div className="m-3 rounded-xl border border-[#d99b22]/40 bg-[#17120a] p-3">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[#d99b22]">
              Needs input
            </p>
            <h3 className="mt-1 text-[14px] font-semibold text-[#f3f4f6]">
              {detectedCliApproval.title}
            </h3>
            <p className="mt-1 text-[12px] leading-5 text-[#aeb7c8]">
              {detectedCliApproval.message}
            </p>
          </div>
        ) : null}
        <div>
          {liveTmuxSession ? (
            <DirectTerminal
              sessionId={liveTmuxSession}
              variant="orchestrator"
              appearance="dark"
              height="calc(100vh - 260px)"
              chromeless
              jobStatus={job.status}
            />
          ) : (
            <RemoteLogTerminal content={job.logTail ?? ""} height="calc(100vh - 260px)" />
          )}
        </div>
        {liveTmuxSession ? null : detectedCliApproval ? (
          <div className="border-t border-[#171923] bg-[#0b0d13] p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.12em] text-[#d99b22]">
                  Choose an option
                </p>
                <p className="mt-1 truncate text-[12px] font-semibold text-[#f3f4f6]">
                  {detectedCliApproval.title}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">{approvalActionButtons}</div>
            </div>
          </div>
        ) : (
          <form
            className="flex items-center gap-2 border-t border-[#171923] bg-[#0b0d13] p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void sendTerminalInput(terminalInput.trim() ? terminalInput : "", true);
            }}
          >
            <span className="font-mono text-[13px] text-[#28c840]">$</span>
            <input
              value={terminalInput}
              onChange={(event) => setTerminalInput(event.target.value)}
              disabled={!canSendInput}
              placeholder={
                canSendInput
                  ? "send input to remote CLI"
                  : `Input disabled because this session is ${effectiveStatus}.`
              }
              className="min-w-0 flex-1 border-none bg-transparent px-1 py-2 font-mono text-[13px] text-[#d8e2ff] outline-none placeholder:text-[#667085] disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isSendingInput || !canSendInput}
                className="rounded-lg bg-[#2937d3] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {terminalInput.trim() ? "Send" : "Enter"}
              </button>
              <button
                type="button"
                disabled={isSendingInput || !canSendInput}
                onClick={() => void sendTerminalInput("", true)}
                className="rounded-lg border border-[#2a2d38] px-4 py-2 text-[12px] font-semibold text-[#d8e2ff] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Enter
              </button>
              <button
                type="button"
                disabled={isSendingInput || !canSendInput}
                onClick={() => void sendTerminalInput("", false, "escape")}
                title="Send Esc to cancel or interrupt the remote CLI"
                className="rounded-lg border border-[#4a2230] px-4 py-2 text-[12px] font-semibold text-[#ff6b78] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Esc
              </button>
            </div>
          </form>
        )}
        {job.pendingInputs && job.pendingInputs.length > 0 ? (
          <p className="mt-2 text-[12px] text-[var(--color-text-tertiary)]">
            {job.pendingInputs.length} input{job.pendingInputs.length === 1 ? "" : "s"} waiting for the bridge.
          </p>
        ) : null}
        {!job.pendingInputs?.length && job.inputHistory?.[0] ? (
          <p className="mt-2 text-[12px] text-[var(--color-text-tertiary)]">
            Last input delivered {formatRelativeTime(job.inputHistory[0].sentAt ?? job.inputHistory[0].createdAt)}.
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function VIRemoteSessionSidePanel({ jobId, initialOverview }: Props) {
  const [overview, setOverview] = useState(initialOverview);
  const [error, setError] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRestartingDaemon, setIsRestartingDaemon] = useState(false);
  const [updatingSetting, setUpdatingSetting] = useState<"ralph" | "usage" | "restart" | "model" | null>(null);
  const [updatingPermission, setUpdatingPermission] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const [continueAgentId, setContinueAgentId] = useState("");

  const job = useMemo<RemoteAgentJob | undefined>(
    () => overview.jobs.find((entry) => entry.jobId === jobId),
    [jobId, overview.jobs],
  );
  const agent = useMemo<RemoteAgentSummary | undefined>(
    () => overview.agents.find((entry) => entry.agentId === job?.agentId),
    [job?.agentId, overview.agents],
  );
  const usageLimitDetected = useMemo(
    () => containsUsageLimit(job?.logTail, job?.error),
    [job?.error, job?.logTail],
  );
  const codexRestartRequired = useMemo(
    () => needsCodexRestart(job?.logTail) || hasUnsupportedModelError(job?.logTail, job?.error),
    [job?.error, job?.logTail],
  );
  const providerHeartbeatFailed = useMemo(
    () => hasProviderHeartbeatFailure(job?.logTail, job?.error),
    [job?.error, job?.logTail],
  );
  const codexIdlePrompt = useMemo(
    () => job?.status === "running" && isCodexIdlePrompt(job?.logTail),
    [job?.logTail, job?.status],
  );
  const effectiveStatus = codexRestartRequired
    ? "restart required"
    : providerHeartbeatFailed
      ? "degraded"
      : codexIdlePrompt
        ? "idle"
      : job?.status;
  const jobProvider = job?.command?.[1]?.toLowerCase() ?? "unknown";
  const isCodexJob = jobProvider === "codex";
  const isClaudeJob = jobProvider === "claude";
  const connectedMachines = useMemo(
    () => overview.agents.filter((entry) => entry.connectionState === "connected"),
    [overview.agents],
  );
  const utilityRequests = useMemo(
    () =>
      overview.requests.filter(
        (request) => request.agentId === job?.agentId && request.parentJobId === job?.jobId,
      ),
    [job?.agentId, job?.jobId, overview.requests],
  );
  const utilityJobs = useMemo(
    () =>
      overview.jobs.filter(
        (entry) =>
          entry.parentJobId === job?.jobId ||
          utilityRequests.some((request) => request.createdJobId === entry.jobId),
      ),
    [job?.jobId, overview.jobs, utilityRequests],
  );
  const activityEvents = useMemo(
    () =>
      overview.events
        .filter(
          (event) =>
            event.jobId === job?.jobId ||
            event.agentId === job?.agentId ||
            utilityRequests.some((request) => request.requestId === event.requestId),
        )
        .slice(0, 8),
    [job?.agentId, job?.jobId, overview.events, utilityRequests],
  );

  useEffect(() => {
    const model = job?.model ?? "";
    const knownOptions = isClaudeJob ? CLAUDE_MODEL_OPTIONS : CODEX_MODEL_OPTIONS;
    const isKnownModel = knownOptions.some((option) => option.value === model);
    setSelectedModel(isKnownModel ? model : model ? "__custom" : "");
    setCustomModel(isKnownModel ? "" : model);
    setSelectedReasoningEffort(job?.reasoningEffort ?? "");
  }, [job?.jobId, job?.model, job?.reasoningEffort, isClaudeJob]);

  useEffect(() => {
    const interval = setInterval(() => {
      void requestJson<RemoteApprovalOverview>("/api/remote-agents/overview")
        .then(setOverview)
        .catch((nextError) =>
          setError(nextError instanceof Error ? nextError.message : "Failed to refresh session info"),
        );
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (continueAgentId && connectedMachines.some((entry) => entry.agentId === continueAgentId)) return;
    setContinueAgentId(agent?.agentId ?? connectedMachines[0]?.agentId ?? "");
  }, [agent?.agentId, connectedMachines, continueAgentId]);

  const updateJobSetting = async (
    next: Pick<RemoteAgentJob, "ralphEnabled" | "autoResumeUsageLimit" | "autoRestartCodex">,
    setting: "ralph" | "usage" | "restart",
  ) => {
    if (!job || !agent) return;
    setUpdatingSetting(setting);
    setError(null);
    try {
      await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          agentId: agent.agentId,
          ...next,
        }),
      });
      setOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update setting");
    } finally {
      setUpdatingSetting(null);
    }
  };

  const updateModelSettings = async (): Promise<RemoteApprovalOverview | null> => {
    if (!job || !agent) return null;
    const effectiveModel = selectedModel === "__custom" ? customModel.trim() : selectedModel;
    setUpdatingSetting("model");
    setError(null);
    try {
      await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          agentId: agent.agentId,
          model: effectiveModel || null,
          reasoningEffort: selectedReasoningEffort || null,
        }),
      });
      const nextOverview = await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview");
      setOverview(nextOverview);
      return nextOverview;
    } catch (nextError) {
      const msg = nextError instanceof Error ? nextError.message : "Failed to update model settings";
      // In cloud mode the relay may not support persisting job settings.
      // The selected settings are kept in form state and will be used by Save and restart.
      if (msg.includes("Unknown remote agent job") || msg.includes("Relay request failed")) {
        setError("Settings could not be saved to the server. They are still selected — click 'Save and restart' to create a new session with these settings.");
      } else {
        setError(msg);
      }
      return null;
    } finally {
      setUpdatingSetting(null);
    }
  };

  const saveModelAndRestart = async () => {
    if (!job || !agent) return;
    setIsRestarting(true);
    setError(null);
    try {
      const effectiveModel = selectedModel === "__custom" ? customModel.trim() : selectedModel;

      if (isClaudeJob) {
        // Save model/reasoning to the existing job record first (best-effort).
        await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            agentId: agent.agentId,
            model: effectiveModel || null,
            reasoningEffort: selectedReasoningEffort || null,
          }),
        }).catch(() => {
          // In cloud mode the PATCH may fail if the job isn't in local store.
          // Proceed anyway — the new job will use the selected model.
        });

        // Create a new Claude job with the updated model via the normal creation
        // endpoint, which properly dispatches through relay in cloud mode.
        const cwd = job.cwd ?? agent.worktree ?? agent.repoRoot;
        if (!cwd) throw new Error("No working directory available for restart");
        const response = await requestJson<{ job: RemoteAgentJob }>(
          "/api/remote-agents/jobs",
          {
            method: "POST",
            body: JSON.stringify({
              agentId: job.agentId,
              provider: "claude",
              cwd,
              model: effectiveModel || undefined,
              reasoningEffort: selectedReasoningEffort || undefined,
              title: `Fresh: ${job.title.replace(/^Fresh: /i, "").slice(0, 80)}`,
              ralphEnabled: job.ralphEnabled,
              autoResumeUsageLimit: job.autoResumeUsageLimit,
            }),
          },
        );
        window.location.href = `/remote-sessions/${encodeURIComponent(response.job.jobId)}`;
      } else {
        // Codex: save model settings then use the Codex-specific restart endpoint.
        await updateModelSettings();
        const response = await requestJson<{ job: RemoteAgentJob }>(
          `/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/restart`,
          {
            method: "POST",
            body: JSON.stringify({ agentId: agent.agentId }),
          },
        );
        window.location.href = `/remote-sessions/${encodeURIComponent(response.job.jobId)}`;
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to restart with saved model");
      setIsRestarting(false);
      setUpdatingSetting(null);
    }
  };

  const updatePermissionMode = async (
    mode: "manual" | "timeout_allow" | "always_allow",
  ) => {
    if (!agent) return;
    setUpdatingPermission(mode);
    setError(null);
    try {
      await requestJson("/api/remote-agents/policy", {
        method: "POST",
        body: JSON.stringify({
          agentId: agent.agentId,
          mode,
          timeoutSeconds: agent.timeoutSeconds,
        }),
      });
      setOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update permission");
    } finally {
      setUpdatingPermission(null);
    }
  };

  const archiveSession = async () => {
    if (!job) return;
    const confirmed = window.confirm("Archive this session?");
    if (!confirmed) return;
    setIsArchiving(true);
    setError(null);
    try {
      await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/archive`, {
        method: "POST",
        body: JSON.stringify({ agentId: job.agentId }),
      });
      window.location.href = "/sessions";
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to archive");
      setIsArchiving(false);
    }
  };

  const removeSession = async () => {
    if (!job) return;
    const confirmed = window.confirm(
      "Remove this session from VI? This clears the session record and related VI requests. Logs may still exist on the machine.",
    );
    if (!confirmed) return;
    setIsRemoving(true);
    setError(null);
    try {
      await requestJson(`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/delete`, {
        method: "POST",
        body: JSON.stringify({ agentId: job.agentId }),
      });
      window.location.href = "/sessions";
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to remove");
      setIsRemoving(false);
    }
  };

  const restartAndResume = async () => {
    if (!job || !agent) return;
    setIsRestarting(true);
    setError(null);
    try {
      const response = await requestJson<{ job: RemoteAgentJob }>(
        `/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/restart`,
        {
          method: "POST",
          body: JSON.stringify({ agentId: agent.agentId }),
        },
      );
      window.location.href = `/remote-sessions/${encodeURIComponent(response.job.jobId)}`;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to restart");
      setIsRestarting(false);
    }
  };

  const restartFresh = async () => {
    if (!job || !agent) return;
    setIsRestarting(true);
    setError(null);
    try {
      if (isClaudeJob) {
        // Claude: create a brand-new job using the same agent/cwd/model.
        // The jobs POST route uses getRemoteAgentsBackend() so it works in both
        // local and cloud/relay mode. Never call the Codex-only restart endpoint.
        const cwd = job.cwd ?? agent.worktree ?? agent.repoRoot;
        if (!cwd) throw new Error("No working directory available for fresh restart");
        const response = await requestJson<{ job: RemoteAgentJob }>(
          "/api/remote-agents/jobs",
          {
            method: "POST",
            body: JSON.stringify({
              agentId: job.agentId,
              provider: "claude",
              cwd,
              model: job.model ?? undefined,
              reasoningEffort: job.reasoningEffort ?? undefined,
              title: `Fresh: ${job.title.replace(/^Fresh: /i, "").slice(0, 80)}`,
              ralphEnabled: job.ralphEnabled,
              autoResumeUsageLimit: job.autoResumeUsageLimit,
            }),
          },
        );
        window.location.href = `/remote-sessions/${encodeURIComponent(response.job.jobId)}`;
      } else {
        // Codex: resume-less fresh restart via the restart endpoint.
        const response = await requestJson<{ job: RemoteAgentJob }>(
          `/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/restart`,
          {
            method: "POST",
            body: JSON.stringify({ agentId: agent.agentId, fresh: true }),
          },
        );
        window.location.href = `/remote-sessions/${encodeURIComponent(response.job.jobId)}`;
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start fresh session");
      setIsRestarting(false);
    }
  };

  const restartDaemon = async () => {
    if (!agent) return;
    setIsRestartingDaemon(true);
    setError(null);
    try {
      await requestJson(`/api/remote-agents/agents/${encodeURIComponent(agent.agentId)}/restart-daemon`, {
        method: "POST",
      });
      setOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to restart daemon");
    } finally {
      setIsRestartingDaemon(false);
    }
  };

  const continueOnMachine = async () => {
    if (!job || !agent || !continueAgentId) return;
    setIsRestarting(true);
    setError(null);
    try {
      const target = overview.agents.find((entry) => entry.agentId === continueAgentId);
      const response = await requestJson<{ job: RemoteAgentJob }>(
        `/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/continue`,
        {
          method: "POST",
          body: JSON.stringify({
            sourceAgentId: agent.agentId,
            targetAgentId: continueAgentId,
            cwd: target?.worktree ?? target?.repoRoot ?? job.cwd,
          }),
        },
      );
      window.location.href = `/remote-sessions/${encodeURIComponent(response.job.jobId)}`;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to continue on machine");
      setIsRestarting(false);
    }
  };

  if (!job || !agent) {
    return (
      <div className="flex-1 p-5 text-[13px] text-[#737882]">
        Session not found.
      </div>
    );
  }

  const settingButton = (
    label: string,
    enabled: boolean | undefined,
    onClick: () => void,
    disabled: boolean,
  ) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "w-full rounded-2xl border px-3 py-2 text-left text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
        enabled
          ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)]"
          : "border-[#e4e4e0] bg-white text-[#444852]",
      ].join(" ")}
    >
      {label}: {enabled ? "on" : "off"}
    </button>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-5">
        <div className="flex flex-wrap gap-2">
          <span className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${statusTone(effectiveStatus ?? "unknown")}`}>
            {effectiveStatus}
          </span>
          <span className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${statusTone(agent.connectionState)}`}>
            {agent.connectionState}
          </span>
        </div>

        <h2 className="mt-4 truncate text-[20px] font-semibold tracking-[-0.03em] text-[#1e2026]">
          {job.title}
        </h2>
        <div className="mt-4 space-y-2 rounded-2xl bg-[#f5f3f0] p-3 text-[12px] leading-5 text-[#626873]">
          <p className="truncate">Host: {agent.hostLabel}</p>
          <p className="truncate">CWD: {job.cwd ?? agent.worktree ?? agent.repoRoot ?? "unknown"}</p>
          <p>Updated {formatRelativeTime(job.updatedAt)}</p>
          {job.nextResumeAt ? <p>Auto resume: {formatRelativeTime(job.nextResumeAt)}</p> : null}
          {job.logFile ? <p className="truncate">Log: {job.logFile}</p> : null}
        </div>

        <button
          type="button"
          disabled={
            isRestartingDaemon ||
            job.status !== "running" ||
            !job.tmuxSession ||
            agent.connectionState === "disabled" ||
            agent.connectionState === "disconnected"
          }
          title={
            job.status !== "running"
              ? "Session has ended — use Fresh restart to start a new session"
              : !job.tmuxSession
                ? "No live terminal session to reconnect to"
                : undefined
          }
          onClick={() => void restartDaemon()}
          className="mt-3 w-full rounded-full border border-[#e4e4e0] bg-white px-3 py-2 text-[12px] font-semibold text-[#444852] hover:border-[var(--color-status-attention)] hover:text-[var(--color-status-attention)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRestartingDaemon ? "Restarting daemon..." : "Restart connection"}
        </button>
        {job.status !== "running" ? (
          <p className="mt-1 text-[11px] leading-4 text-[#8a909b]">
            Session ended — use Fresh restart to start a new session below.
          </p>
        ) : null}
        <button
          type="button"
          disabled={isRestarting}
          onClick={() => void restartFresh()}
          className="mt-2 w-full rounded-full border border-[#e4e4e0] bg-white px-3 py-2 text-[12px] font-semibold text-[#444852] hover:border-[#5964d8] hover:text-[#5964d8] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRestarting ? "Starting..." : "Fresh restart session"}
        </button>

        {error ? (
          <div className="mt-3 rounded-2xl border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red-soft)] p-3 text-[12px] text-[var(--color-accent-red)]">
            {error}
          </div>
        ) : null}

        {SHOW_HANDOFF_CONTROLS ? (
        <div className="mt-4 rounded-2xl border border-[#e4e4e0] bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9aa0aa]">
            Continue elsewhere
          </p>
          <div className="mt-3 grid gap-2">
            <select
              value={continueAgentId}
              onChange={(event) => setContinueAgentId(event.currentTarget.value)}
              className="rounded-xl border border-[#e4e4e0] bg-[#f8f7f4] px-3 py-2 text-[12px] font-semibold text-[#1e2026]"
            >
              {connectedMachines.map((machine) => (
                <option key={machine.agentId} value={machine.agentId}>
                  {machine.displayName} / {machine.hostLabel}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={isRestarting || !continueAgentId}
              onClick={() => void continueOnMachine()}
              className="rounded-full border border-[#5964d8] bg-white px-3 py-2 text-[12px] font-semibold text-[#5964d8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRestarting ? "Starting..." : "Continue from handoff"}
            </button>
          </div>
        </div>
        ) : null}

        <div className="mt-4 rounded-2xl border border-[#e4e4e0] bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9aa0aa]">
            Permission
          </p>
          <div className={`mt-3 grid gap-1 rounded-full bg-[#f3f2ef] p-1 ${isClaudeJob ? "grid-cols-2" : "grid-cols-3"}`}>
            {(isClaudeJob
              ? [
                  { label: "Manual", mode: "manual" },
                  { label: "Always", mode: "always_allow" },
                ]
              : [
                  { label: "Manual", mode: "manual" },
                  { label: "Auto 10s", mode: "timeout_allow" },
                  { label: "Always", mode: "always_allow" },
                ]
            ).map((item) => {
              const active = agent.permissionMode === item.mode;
              return (
                <button
                  key={item.mode}
                  type="button"
                  disabled={updatingPermission !== null}
                  onClick={() =>
                    void updatePermissionMode(item.mode as "manual" | "timeout_allow" | "always_allow")
                  }
                  className={[
                    "rounded-full px-2 py-2 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "bg-[#5964d8] text-white shadow-sm"
                      : "text-[#555b66] hover:bg-white",
                  ].join(" ")}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-[#e4e4e0] bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9aa0aa]">
            Model
          </p>
          <div className="mt-3 grid gap-2">
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.currentTarget.value)}
              className="rounded-xl border border-[#e4e4e0] bg-[#f8f7f4] px-3 py-2 text-[12px] font-semibold text-[#1e2026]"
            >
              {(isClaudeJob ? CLAUDE_MODEL_OPTIONS : CODEX_MODEL_OPTIONS).map((option) => (
                <option key={option.value || "default"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {selectedModel === "__custom" ? (
              <input
                value={customModel}
                onChange={(event) => setCustomModel(event.currentTarget.value)}
                placeholder={isClaudeJob ? "e.g. claude-opus-4-7" : "e.g. gpt-5.5"}
                className="rounded-xl border border-[#e4e4e0] bg-[#f8f7f4] px-3 py-2 text-[12px] font-semibold text-[#1e2026]"
              />
            ) : null}
            <select
              value={selectedReasoningEffort}
              onChange={(event) => setSelectedReasoningEffort(event.currentTarget.value)}
              className="rounded-xl border border-[#e4e4e0] bg-[#f8f7f4] px-3 py-2 text-[12px] font-semibold text-[#1e2026]"
            >
              {REASONING_OPTIONS.map((option) => (
                <option key={option.value || "default"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={
                updatingSetting !== null ||
                ((selectedModel === "__custom" ? customModel.trim() : selectedModel) === (job.model ?? "") &&
                  selectedReasoningEffort === (job.reasoningEffort ?? ""))
              }
              onClick={() => void updateModelSettings()}
              className="rounded-full bg-[#5964d8] px-3 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {updatingSetting === "model" ? "Saving..." : "Save for restart"}
            </button>
            <button
              type="button"
              disabled={updatingSetting !== null || isRestarting}
              onClick={() => void saveModelAndRestart()}
              className="rounded-full border border-[#5964d8] bg-white px-3 py-2 text-[12px] font-semibold text-[#5964d8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRestarting ? "Restarting..." : "Save and restart"}
            </button>
            <p className="text-[11px] leading-4 text-[#7b808b]">
              {isClaudeJob
                ? "Default uses Claude Code's configured model."
                : "Restart/resume is required for Codex model changes."}
            </p>
            {codexRestartRequired ? (
              <p className="rounded-xl border border-[#ff6b78]/35 bg-[#fff0f2] px-3 py-2 text-[11px] leading-4 text-[#9f2434]">
                This Codex process rejected the selected model or needs a newer CLI. Pick Codex default or another model,
                then Save and restart.
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {settingButton("Ralph mode", job.ralphEnabled, () => {
            void updateJobSetting({ ralphEnabled: !job.ralphEnabled }, "ralph");
          }, updatingSetting !== null)}
          {settingButton("Usage auto-resume", job.autoResumeUsageLimit, () => {
            void updateJobSetting({ autoResumeUsageLimit: !job.autoResumeUsageLimit }, "usage");
          }, updatingSetting !== null)}
          {isCodexJob ? settingButton("Codex auto-restart", job.autoRestartCodex, () => {
            void updateJobSetting({ autoRestartCodex: !job.autoRestartCodex }, "restart");
          }, updatingSetting !== null) : null}
        </div>

        {usageLimitDetected ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-status-attention)]/40 bg-[var(--color-status-attention-soft)] p-3 text-[12px] leading-5 text-[#626873]">
            Usage limit detected. {job.autoResumeUsageLimit ? "Auto-resume is on." : "Auto-resume is off."}
          </div>
        ) : null}

        {(isCodexJob && codexRestartRequired) || providerHeartbeatFailed ? (
          <div className="mt-4 rounded-2xl border border-[var(--color-status-attention)]/40 bg-[var(--color-status-attention-soft)] p-3">
            <p className="text-[12px] font-semibold text-[#1e2026]">
              {codexRestartRequired ? "Restart needed" : "Session degraded"}
            </p>
            <button
              type="button"
              disabled={isRestarting}
              onClick={() => void restartAndResume()}
              className="mt-3 w-full rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRestarting ? "Restarting..." : "Restart and resume"}
            </button>
          </div>
        ) : null}

        <div className="mt-4 rounded-2xl border border-[#e4e4e0] bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9aa0aa]">
              Activity
            </p>
            <span className="text-[10px] text-[#9aa0aa]">{activityEvents.length}</span>
          </div>
          <div className="mt-3 grid gap-2">
            {activityEvents.length > 0 ? (
              activityEvents.map((event) => (
                <div key={event.eventId} className="rounded-xl bg-[#f8f7f4] px-3 py-2">
                  <p className="line-clamp-2 text-[12px] font-semibold leading-5 text-[#30343b]">
                    {remoteEventLabel(event)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[#8a909b]">
                    {formatRelativeTime(event.createdAt)}
                  </p>
                </div>
              ))
            ) : (
              <p className="rounded-xl bg-[#f8f7f4] px-3 py-2 text-[12px] text-[#737882]">
                No events yet.
              </p>
            )}
          </div>
        </div>

        {utilityJobs.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-[#cfd3ff] bg-[#f7f7ff] p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5964d8]">
              Helper sessions
            </p>
            <div className="mt-2 grid gap-2">
              {utilityJobs.slice(0, 3).map((utilityJob) => (
                <a
                  key={utilityJob.jobId}
                  href={`/remote-sessions/${encodeURIComponent(utilityJob.jobId)}`}
                  className="rounded-xl bg-white px-3 py-2 text-[12px] hover:no-underline"
                >
                  <span className="block truncate font-semibold text-[#1e2026]">
                    {utilityJob.title}
                  </span>
                  <span className="text-[#737882]">
                    {utilityJob.status} - {formatRelativeTime(utilityJob.updatedAt)}
                  </span>
                </a>
              ))}
            </div>
          </div>
        ) : null}

        {SHOW_HANDOFF_CONTROLS ? (
        <details className="mt-4 rounded-2xl border border-[#ececea] bg-white/60 p-3 text-[11px] text-[#737882]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <span className="font-semibold uppercase tracking-[0.12em] text-[#a1a6b0]">
              Handoff
            </span>
            <a
              href={`/api/remote-agents/jobs/${encodeURIComponent(job.jobId)}/export?agentId=${encodeURIComponent(job.agentId)}`}
              download
              onClick={(event) => event.stopPropagation()}
              className="rounded-full border border-[#e4e4e0] px-2.5 py-1 text-[10px] font-semibold text-[#6b7080] hover:border-[#5964d8] hover:text-[#5964d8]"
            >
              Download
            </a>
          </summary>
          <div className="mt-3 space-y-2 leading-4">
            {([
              ["PROGRESS", job.handoff?.progress],
              ["TODO", job.handoff?.todo],
              ["NOTES", job.handoff?.notes],
            ] as const).map(([label, value]) => {
              const preview = compactMarkdownPreview(value);
              return (
                <p key={label} className="line-clamp-2">
                  <span className="font-semibold text-[#8d93a0]">{label}: </span>
                  {preview || "Not reported yet."}
                </p>
              );
            })}
            {job.artifactsDir ? <p className="truncate">Dir: {job.artifactsDir}</p> : null}
          </div>
        </details>
        ) : null}
      </div>

      <div className="border-t border-[#ececea] p-5">
        <div className="grid gap-2">
          <button
            type="button"
            disabled={isArchiving || isRemoving}
            onClick={() => void archiveSession()}
            className="w-full rounded-full border border-[#e4e4e0] px-4 py-2 text-[12px] font-semibold text-[#444852] hover:border-[var(--color-accent-red)] hover:text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isArchiving ? "Archiving..." : `Archive ${job.jobId.replace(/^raj_/, "").slice(0, 8)}`}
          </button>
          <button
            type="button"
            disabled={isArchiving || isRemoving}
            onClick={() => void removeSession()}
            className="w-full rounded-full border border-[var(--color-accent-red)]/50 px-4 py-2 text-[12px] font-semibold text-[var(--color-accent-red)] hover:bg-[var(--color-accent-red-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRemoving ? "Removing..." : `Remove ${job.jobId.replace(/^raj_/, "").slice(0, 8)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
