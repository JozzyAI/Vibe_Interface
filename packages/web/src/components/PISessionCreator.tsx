"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type {
  PIApprovalPermissionMode,
  RemoteAgentJob,
  RemoteAgentSummary,
  RemoteApprovalOverview,
} from "@/lib/types";

interface Props {
  initialRemoteOverview: RemoteApprovalOverview;
  workspaceRoot: string;
}

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

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? "New PI session").slice(0, 96);
}

function safeFolderName(title: string): string {
  return (
    title
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|#%{}[\]^~`]+/g, " ")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .toLowerCase() || "pi-session"
  );
}

function permissionLabel(mode: PIApprovalPermissionMode): string {
  if (mode === "timeout_allow") return "Auto-approve after 10s";
  if (mode === "always_allow") return "Always allow for this session";
  return "Ask every time";
}

function defaultWorkspace(root: string, prompt: string, title: string): string {
  const cleanTitle = title.trim() || titleFromPrompt(prompt);
  return `${root.replace(/[\\/]+$/g, "")}/${safeFolderName(cleanTitle)}`;
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

const REASONING_OPTIONS = [
  { value: "", label: "Default thinking" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

export function PISessionCreator({ initialRemoteOverview, workspaceRoot }: Props) {
  const [overview, setOverview] = useState(initialRemoteOverview);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState(workspaceRoot);
  const [permissionMode, setPermissionMode] = useState<PIApprovalPermissionMode>("manual");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [ralphEnabled, setRalphEnabled] = useState(false);
  const [autoResumeUsageLimit, setAutoResumeUsageLimit] = useState(false);
  const [autoRestartCodex, setAutoRestartCodex] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const interval = setInterval(() => {
      void requestJson<RemoteApprovalOverview>("/api/remote-agents/overview")
        .then(setOverview)
        .catch(() => void 0);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const connectedMachines = useMemo(
    () => overview.agents.filter((agent) => agent.connectionState === "connected"),
    [overview.agents],
  );

  useEffect(() => {
    if (selectedAgentId && connectedMachines.some((agent) => agent.agentId === selectedAgentId)) return;
    setSelectedAgentId(connectedMachines[0]?.agentId ?? "");
  }, [connectedMachines, selectedAgentId]);

  const selectedAgent = connectedMachines.find((agent) => agent.agentId === selectedAgentId);
  const effectiveTitle = title.trim() || titleFromPrompt(prompt);
  const effectiveModel = model === "__custom" ? customModel.trim() : model;

  const startSession = () =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          setMessage(null);
          const cleanPrompt = prompt.trim();
          if (!selectedAgent) throw new Error("Connect a machine first");
          if (!cleanPrompt) throw new Error("Initial prompt is required");

          const cwd = workspace.trim() || defaultWorkspace(workspaceRoot, cleanPrompt, effectiveTitle);
          await requestJson("/api/remote-agents/policy", {
            method: "POST",
            body: JSON.stringify({
              agentId: selectedAgent.agentId,
              mode: permissionMode,
              timeoutSeconds: selectedAgent.timeoutSeconds,
            }),
          });

          const result = await requestJson<{ job: RemoteAgentJob }>("/api/remote-agents/jobs", {
            method: "POST",
            body: JSON.stringify({
              agentId: selectedAgent.agentId,
              provider: selectedAgent.toolType.toLowerCase().includes("claude") ? "claude" : "codex",
              cwd,
              title: effectiveTitle,
              prompt: [
                "Start a new PI-managed coding session.",
                `Workspace folder: ${cwd}`,
                `Permission mode: ${permissionLabel(permissionMode)}`,
                effectiveModel ? `Codex model: ${effectiveModel}` : "Codex model: default.",
                reasoningEffort ? `Thinking effort: ${reasoningEffort}` : "Thinking effort: default.",
                ralphEnabled
                  ? [
                      "True Ralph mode: enabled.",
                      "Do one bounded iteration, summarize the result, then exit.",
                      "Print COMPLETE on its own line only if the whole task is finished; otherwise print CONTINUE on its own line.",
                    ].join(" ")
                  : "True Ralph mode: disabled. Complete the requested task, then stay open and wait for follow-up instructions from PI.",
                autoResumeUsageLimit
                  ? "Usage-limit recovery: enabled. If the provider says usage limit is reached, stop safely; PI will auto-resume later."
                  : "Usage-limit recovery: disabled.",
                autoRestartCodex
                  ? "Codex restart recovery: enabled. If Codex says restart is required, PI will resume this session in a fresh process."
                  : "Codex restart recovery: disabled.",
                "",
                "Use PI approval flow for risky operations. Keep work scoped to this session.",
                "",
                cleanPrompt,
              ].join("\n"),
              env: {
                PI_SESSION_TITLE: effectiveTitle,
                PI_SESSION_SOURCE: "sessions-new",
                PI_RALPH_ENABLED: ralphEnabled ? "1" : "0",
                PI_RALPH_MODE: ralphEnabled ? "iteration" : "off",
                PI_RALPH_ITERATION: ralphEnabled ? "1" : "",
                PI_AUTO_RESUME_USAGE_LIMIT: autoResumeUsageLimit ? "1" : "0",
                PI_AUTO_RESTART_CODEX: autoRestartCodex ? "1" : "0",
                PI_CODEX_MODEL: effectiveModel,
                PI_CODEX_REASONING_EFFORT: reasoningEffort,
              },
              ralphEnabled,
              autoResumeUsageLimit,
              autoRestartCodex,
              model: effectiveModel || undefined,
              reasoningEffort: reasoningEffort || undefined,
            }),
          });

          setMessage(`Session queued on ${selectedAgent.displayName}. Opening live view...`);
          window.location.href = `/remote-sessions/${encodeURIComponent(result.job.jobId)}`;
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to start session");
        }
      })();
    });

  if (connectedMachines.length === 0) {
    return (
      <section className="rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Add session
        </p>
        <h2 className="mt-2 text-[28px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
          Connect a machine first
        </h2>
        <p className="mt-2 text-[14px] leading-7 text-[var(--color-text-secondary)]">
          PI needs at least one online machine before it can start a session.
        </p>
        <a
          href="/agents/new"
          className="mt-5 inline-flex rounded-full bg-[var(--color-accent)] px-5 py-3 text-[13px] font-semibold text-white hover:no-underline"
        >
          Add machine
        </a>
      </section>
    );
  }

  return (
    <div className="grid gap-5">
      <section className="rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Add session
            </p>
            <h2 className="mt-2 text-[30px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
              Start a session on a machine
            </h2>
            <p className="mt-2 max-w-2xl text-[14px] leading-7 text-[var(--color-text-secondary)]">
              Choose where the coding agent runs, set the approval mode, and give it the initial prompt.
            </p>
          </div>
          <span className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)]">
            {connectedMachines.length} online
          </span>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Machine
            </label>
            <select
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.currentTarget.value)}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)]"
            >
              {connectedMachines.map((agent: RemoteAgentSummary) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.displayName} / {agent.toolType} / {agent.hostLabel}
                </option>
              ))}
            </select>
            {model === "__custom" ? (
              <input
                value={customModel}
                onChange={(event) => setCustomModel(event.currentTarget.value)}
                placeholder="e.g. gpt-5.5"
                className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)]"
              />
            ) : null}
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Permission
            </label>
            <select
              value={permissionMode}
              onChange={(event) => setPermissionMode(event.currentTarget.value as PIApprovalPermissionMode)}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)]"
            >
              <option value="manual">Ask every time</option>
              <option value="timeout_allow">Auto-approve after 10s</option>
              <option value="always_allow">Always allow for this session</option>
            </select>
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Model
            </label>
            <select
              value={model}
              onChange={(event) => setModel(event.currentTarget.value)}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)]"
            >
            {CODEX_MODEL_OPTIONS.map((option) => (
              <option key={option.value || "default"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
            {model === "gpt-5.5" || model === "gpt-5.2-codex" || model === "gpt-5.2-pro" ? (
              <p className="text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                This model may depend on your Codex CLI version or account. Codex default is the safest start.
              </p>
            ) : null}
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Thinking
            </label>
            <select
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.currentTarget.value)}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)]"
            >
              {REASONING_OPTIONS.map((option) => (
                <option key={option.value || "default"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Session title
            </label>
            <input
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              placeholder="Optional. First prompt line is used if empty."
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)]"
            />
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Workspace folder
            </label>
            <input
              value={workspace}
              onChange={(event) => setWorkspace(event.currentTarget.value)}
              onFocus={() => {
                if (workspace === workspaceRoot) {
                  setWorkspace(defaultWorkspace(workspaceRoot, prompt, effectiveTitle));
                }
              }}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)]"
            />
          </div>
        </div>

        <div className="mt-4 grid gap-1">
          <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Initial prompt
          </label>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Tell the agent exactly what to build, fix, inspect, or continue."
            className="min-h-[220px] resize-y rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-4 text-[14px] leading-7 text-[var(--color-text-primary)] outline-none"
          />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <button
            type="button"
            onClick={() => setRalphEnabled((current) => !current)}
            className={[
              "rounded-3xl border px-4 py-4 text-left transition",
              ralphEnabled
                ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                : "border-[var(--color-border-default)] bg-[var(--color-bg-base)]",
            ].join(" ")}
          >
            <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              True Ralph mode
            </span>
            <span className="mt-1 block text-[15px] font-semibold text-[var(--color-text-primary)]">
              {ralphEnabled ? "Ralph iterations enabled" : "Enable Ralph iterations"}
            </span>
            <span className="mt-1 block text-[12px] leading-5 text-[var(--color-text-secondary)]">
              Runs one bounded pass, exits, then PI starts the next pass if the task is not complete.
            </span>
          </button>

          <button
            type="button"
            onClick={() => setAutoResumeUsageLimit((current) => !current)}
            className={[
              "rounded-3xl border px-4 py-4 text-left transition",
              autoResumeUsageLimit
                ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                : "border-[var(--color-border-default)] bg-[var(--color-bg-base)]",
            ].join(" ")}
          >
            <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Usage limit
            </span>
            <span className="mt-1 block text-[15px] font-semibold text-[var(--color-text-primary)]">
              {autoResumeUsageLimit ? "Auto resume enabled" : "Auto resume after usage limit"}
            </span>
            <span className="mt-1 block text-[12px] leading-5 text-[var(--color-text-secondary)]">
              If Codex hits a usage limit, PI queues a follow-up session for the retry time.
            </span>
          </button>

          <button
            type="button"
            onClick={() => setAutoRestartCodex((current) => !current)}
            className={[
              "rounded-3xl border px-4 py-4 text-left transition",
              autoRestartCodex
                ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                : "border-[var(--color-border-default)] bg-[var(--color-bg-base)]",
            ].join(" ")}
          >
            <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Codex restart
            </span>
            <span className="mt-1 block text-[15px] font-semibold text-[var(--color-text-primary)]">
              {autoRestartCodex ? "Auto restart enabled" : "Auto restart Codex"}
            </span>
            <span className="mt-1 block text-[12px] leading-5 text-[var(--color-text-secondary)]">
              If Codex says restart is required, PI launches a fresh process and resumes this session.
            </span>
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px] text-[var(--color-text-tertiary)]">
            New session will open in the Sessions live view after it is queued.
          </p>
          <button
            type="button"
            disabled={isPending || !prompt.trim() || !selectedAgent}
            onClick={startSession}
            className="rounded-full bg-[var(--color-accent)] px-5 py-3 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "Starting..." : "Start session"}
          </button>
        </div>

        {message ? <p className="mt-4 text-[13px] font-medium text-[var(--color-status-success)]">{message}</p> : null}
        {error ? <p className="mt-4 text-[13px] font-medium text-[var(--color-accent-red)]">{error}</p> : null}
      </section>

      <section className="rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-5">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Good next additions
        </p>
        <div className="mt-3 grid gap-3 text-[13px] leading-6 text-[var(--color-text-secondary)] md:grid-cols-3">
          <div className="rounded-2xl bg-[var(--color-bg-base)] p-4">
            Prompt templates for common jobs like bug fix, refactor, review, and test writing.
          </div>
          <div className="rounded-2xl bg-[var(--color-bg-base)] p-4">
            Attach files or folders as context before starting the session.
          </div>
          <div className="rounded-2xl bg-[var(--color-bg-base)] p-4">
            Queue sessions for offline machines and start them automatically when the machine reconnects.
          </div>
        </div>
      </section>
    </div>
  );
}
