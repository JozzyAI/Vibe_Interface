"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type {
  VIApprovalPermissionMode,
  RemoteAgentJob,
  RemoteAgentSummary,
  RemoteApprovalOverview,
} from "@/lib/types";

interface Props {
  initialRemoteOverview: RemoteApprovalOverview;
  workspaceRoot: string;
  claudeDefaultModel?: string;
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

function permissionLabel(mode: VIApprovalPermissionMode): string {
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
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
  { value: "gpt-5.2-pro", label: "gpt-5.2-pro" },
  { value: "gpt-5.2", label: "gpt-5.2" },
  { value: "gpt-5-codex", label: "gpt-5-codex" },
  { value: "gpt-5-mini", label: "gpt-5-mini" },
];

function buildClaudeModelOptions(configuredDefault?: string) {
  const defaultLabel = configuredDefault
    ? `Default (configured: ${configuredDefault})`
    : "Default — omit --model flag";
  return [
    { value: "", label: defaultLabel },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { value: "claude-opus-4-7", label: "Opus 4.7" },
    { value: "__custom", label: "Custom..." },
  ];
}

const REASONING_OPTIONS = [
  { value: "", label: "Default thinking" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

interface BrowseEntry { name: string; isDir: boolean; }
interface BrowseResult { path: string; agentRoot: string; entries: BrowseEntry[]; }

export function VISessionCreator({ initialRemoteOverview, workspaceRoot, claudeDefaultModel }: Props) {
  const [overview, setOverview] = useState(initialRemoteOverview);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState(workspaceRoot);
  const [permissionMode, setPermissionMode] = useState<VIApprovalPermissionMode>("manual");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const modelOptions = provider === "claude" ? buildClaudeModelOptions(claudeDefaultModel) : CODEX_MODEL_OPTIONS;
  const [ralphEnabled, setRalphEnabled] = useState(false);
  const [autoResumeUsageLimit, setAutoResumeUsageLimit] = useState(false);
  const [autoRestartCodex, setAutoRestartCodex] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Folder browser state
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([]);
  const [browseRoot, setBrowseRoot] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);

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
  const agentDefaultRoot = selectedAgent?.worktree ?? selectedAgent?.repoRoot ?? null;

  // When selected agent changes, update workspace default to agent's root
  useEffect(() => {
    if (agentDefaultRoot) setWorkspace(agentDefaultRoot);
  }, [agentDefaultRoot]);

  // Reset model when provider changes
  useEffect(() => {
    setModel("");
    setCustomModel("");
  }, [provider]);

  // Folder browser helpers
  const loadBrowse = async (agentId: string, path?: string) => {
    setBrowseError(null);
    try {
      const url = path
        ? `/api/remote-agents/agents/${encodeURIComponent(agentId)}/browse?path=${encodeURIComponent(path)}`
        : `/api/remote-agents/agents/${encodeURIComponent(agentId)}/browse`;
      const result = await requestJson<BrowseResult>(url);
      setBrowsePath(result.path);
      setBrowseRoot(result.agentRoot);
      setBrowseEntries(result.entries);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Failed to browse");
    }
  };

  const openBrowser = () => {
    if (!selectedAgent) return;
    setBrowseOpen(true);
    setShowNewFolder(false);
    setNewFolderName("");
    void loadBrowse(selectedAgent.agentId);
  };

  const createFolder = async () => {
    if (!selectedAgent || !browsePath || !newFolderName.trim()) return;
    try {
      const result = await requestJson<{ path: string }>(
        `/api/remote-agents/agents/${encodeURIComponent(selectedAgent.agentId)}/browse`,
        { method: "POST", body: JSON.stringify({ parent: browsePath, name: newFolderName.trim() }) },
      );
      setNewFolderName("");
      setShowNewFolder(false);
      void loadBrowse(selectedAgent.agentId, result.path);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  const effectiveTitle = title.trim() || titleFromPrompt(prompt);
  // Resolve __custom sentinel; treat empty/default as no model (omit --model flag)
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
              provider,
              cwd,
              title: effectiveTitle,
              prompt: [
                "Start a new PI-managed coding session.",
                `Workspace folder: ${cwd}`,
                `Permission mode: ${permissionLabel(permissionMode)}`,
                effectiveModel ? `Model: ${effectiveModel}` : "Model: default.",
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
                "Use VI approval flow for risky operations. Keep work scoped to this session.",
                "",
                cleanPrompt,
              ].join("\n"),
              env: {
                VI_SESSION_TITLE: effectiveTitle,
                VI_SESSION_SOURCE: "sessions-new",
                VI_RALPH_ENABLED: ralphEnabled ? "1" : "0",
                VI_RALPH_MODE: ralphEnabled ? "iteration" : "off",
                VI_RALPH_ITERATION: ralphEnabled ? "1" : "",
                VI_AUTO_RESUME_USAGE_LIMIT: autoResumeUsageLimit ? "1" : "0",
                VI_AUTO_RESTART_CODEX: autoRestartCodex ? "1" : "0",
                VI_CODEX_MODEL: effectiveModel,
                VI_CODEX_REASONING_EFFORT: reasoningEffort,
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
      <section className="rounded-3xl border border-[var(--color-border-default)] bg-white p-6">
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
      <section className="rounded-3xl border border-[#e8e8e5] bg-white p-6">
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
              className="rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
            >
              {connectedMachines.map((agent: RemoteAgentSummary) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.displayName} / {agent.hostLabel}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Provider
            </label>
            <select
              value={provider}
              onChange={(event) => {
                const next = event.currentTarget.value as "claude" | "codex";
                setProvider(next);
                // timeout_allow is not supported for Claude — reset to manual when switching
                if (next === "claude" && permissionMode === "timeout_allow") setPermissionMode("manual");
              }}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
            >
              <option value="claude">Claude Code</option>
              <option value="codex">Codex CLI</option>
            </select>
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Permission
            </label>
            <select
              value={permissionMode}
              onChange={(event) => setPermissionMode(event.currentTarget.value as VIApprovalPermissionMode)}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
            >
              {provider === "claude" ? (
                <>
                  <option value="manual">Manual — Claude asks in the terminal</option>
                  <option value="always_allow">Always — bypass Claude approval prompts</option>
                </>
              ) : (
                <>
                  <option value="manual">Ask every time</option>
                  <option value="timeout_allow">Auto-approve after 10s</option>
                  <option value="always_allow">Always allow for this session</option>
                </>
              )}
            </select>
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Model
            </label>
            <select
              value={model}
              onChange={(event) => setModel(event.currentTarget.value)}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
            >
              {modelOptions.map((option) => (
                <option key={option.value || "default"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {model === "__custom" ? (
              <input
                value={customModel}
                onChange={(event) => setCustomModel(event.currentTarget.value)}
                placeholder={provider === "claude" ? "e.g. claude-opus-4-7" : "e.g. gpt-5.5"}
                className="rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
              />
            ) : null}
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Thinking
            </label>
            <select
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.currentTarget.value)}
              className="rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
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
              className="rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
            />
          </div>

          <div className="grid gap-1 md:col-span-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                Workspace folder
              </label>
              {/* Auto resume — inline toggle on the right of workspace row */}
              <button
                type="button"
                onClick={() => setAutoResumeUsageLimit((current) => !current)}
                className={[
                  "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition",
                  autoResumeUsageLimit
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                    : "border-[var(--color-border-default)] bg-[#f7f7f6] text-[var(--color-text-secondary)]",
                ].join(" ")}
              >
                <span className={[
                  "inline-block h-1.5 w-1.5 rounded-full",
                  autoResumeUsageLimit ? "bg-[var(--color-accent)]" : "bg-[var(--color-text-tertiary)]",
                ].join(" ")} />
                {autoResumeUsageLimit ? "Auto resume on" : "Auto resume"}
              </button>
            </div>
            <div className="flex gap-2">
              <input
                value={workspace}
                onChange={(event) => setWorkspace(event.currentTarget.value)}
                className="min-w-0 flex-1 rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-4 py-3 text-[13px] text-[#1e2026]"
              />
              {selectedAgent && agentDefaultRoot ? (
                <button
                  type="button"
                  onClick={() => { setBrowseOpen((v) => !v); if (!browseOpen) openBrowser(); }}
                  className="shrink-0 rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6] px-3 py-3 text-[12px] font-semibold text-[var(--color-text-secondary)] hover:bg-white"
                  title="Browse folders"
                >
                  Browse
                </button>
              ) : null}
            </div>

            {browseOpen && selectedAgent ? (
              <div className="mt-2 overflow-hidden rounded-2xl border border-[var(--color-border-default)] bg-[#f7f7f6]">
                {/* Breadcrumb */}
                <div className="flex items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-2 text-[11px]">
                  <span className="text-[var(--color-text-tertiary)]">Root:</span>
                  <button
                    type="button"
                    onClick={() => void loadBrowse(selectedAgent.agentId, browseRoot ?? undefined)}
                    className="truncate font-mono text-[var(--color-accent)] hover:underline"
                  >
                    {browseRoot ?? "…"}
                  </button>
                  {browsePath && browseRoot && browsePath !== browseRoot ? (
                    <>
                      <span className="text-[var(--color-text-tertiary)]">/</span>
                      <span className="truncate font-mono text-[var(--color-text-primary)]">
                        {browsePath.slice(browseRoot.length + 1)}
                      </span>
                    </>
                  ) : null}
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setShowNewFolder((v) => !v); setNewFolderName(""); }}
                      className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:bg-white"
                    >
                      + New folder
                    </button>
                    <button
                      type="button"
                      onClick={() => setBrowseOpen(false)}
                      className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* New folder input */}
                {showNewFolder ? (
                  <div className="flex gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
                    <input
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); }}
                      placeholder="New folder name"
                      autoFocus
                      className="min-w-0 flex-1 rounded-xl border border-[var(--color-border-default)] bg-white px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void createFolder()}
                      disabled={!newFolderName.trim()}
                      className="rounded-xl bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      Create
                    </button>
                  </div>
                ) : null}

                {browseError ? (
                  <p className="px-3 py-3 text-[12px] text-[var(--color-accent-red)]">{browseError}</p>
                ) : null}

                {/* Go up */}
                {browsePath && browseRoot && browsePath !== browseRoot ? (
                  <button
                    type="button"
                    onClick={() => {
                      const parent = browsePath.split("/").slice(0, -1).join("/") || browseRoot;
                      void loadBrowse(selectedAgent.agentId, parent);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-white"
                  >
                    <span className="text-[var(--color-text-tertiary)]">↑</span> ..
                  </button>
                ) : null}

                {/* Directory list */}
                <div className="max-h-48 overflow-y-auto">
                  {browseEntries.length === 0 && !browseError ? (
                    <p className="px-3 py-3 text-[12px] text-[var(--color-text-tertiary)]">Empty folder</p>
                  ) : null}
                  {browseEntries.map((entry) => {
                    const entryPath = `${browsePath}/${entry.name}`;
                    return (
                      <div key={entry.name} className="flex items-center gap-1 hover:bg-white">
                        <button
                          type="button"
                          onClick={() => void loadBrowse(selectedAgent.agentId, entryPath)}
                          className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--color-text-primary)]"
                        >
                          <span className="text-[var(--color-text-tertiary)]">📁</span>
                          {entry.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setWorkspace(entryPath); setBrowseOpen(false); }}
                          className="mr-2 shrink-0 rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)]"
                        >
                          Select
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Select current path */}
                <div className="border-t border-[var(--color-border-subtle)] px-3 py-2">
                  <button
                    type="button"
                    onClick={() => { if (browsePath) setWorkspace(browsePath); setBrowseOpen(false); }}
                    className="text-[11px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    Use this folder →
                  </button>
                </div>
              </div>
            ) : null}
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
            className="min-h-[220px] resize-y rounded-3xl border border-[#e8e8e5] bg-[#f7f7f6] px-4 py-4 text-[14px] leading-7 text-[#1e2026] outline-none"
          />
        </div>

        {/* Ralph mode — hidden for now, code intact */}
        {/* TODO: re-enable when Ralph mode is ready for users
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setRalphEnabled((current) => !current)}
            className={[
              "rounded-3xl border px-4 py-4 text-left transition",
              ralphEnabled
                ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                : "border-[var(--color-border-default)] bg-[#f7f7f6]",
            ].join(" ")}
          >
            <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">True Ralph mode</span>
            <span className="mt-1 block text-[15px] font-semibold text-[var(--color-text-primary)]">
              {ralphEnabled ? "Ralph iterations enabled" : "Enable Ralph iterations"}
            </span>
            <span className="mt-1 block text-[12px] leading-5 text-[var(--color-text-secondary)]">
              Runs one bounded pass, exits, then PI starts the next pass if the task is not complete.
            </span>
          </button>
        </div>
        */}

        {/* Codex auto-restart — only shown for Codex sessions */}
        {provider === "codex" ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setAutoRestartCodex((current) => !current)}
              className={[
                "rounded-3xl border px-4 py-4 text-left transition",
                autoRestartCodex
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                  : "border-[var(--color-border-default)] bg-[#f7f7f6]",
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
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
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

    </div>
  );
}
