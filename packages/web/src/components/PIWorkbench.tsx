"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ModeIndicator } from "@/components/ModeIndicator";
import type {
  DashboardSession,
  PIIdeaBoardData,
  RemoteAgentJob,
  RemoteAgentSessionHistoryItem,
  RemoteApprovalOverview,
} from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";

interface Props {
  initialSessions: DashboardSession[];
  initialRemoteOverview: RemoteApprovalOverview;
  ideaBoard?: PIIdeaBoardData;
  projectId?: string;
  projectName?: string;
  projects: ProjectInfo[];
  workspaceRoot: string;
  workspaceFiles: string[];
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

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "just now";
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(diffMinutes) || diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? "Untitled PI task").slice(0, 96);
}

function safeFolderName(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#%{}[\]^~`]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .toLowerCase() || "pi-task";
}

function fileGlyph(name: string): string {
  if (!name.includes(".")) return ">";
  return "|";
}

function humanRemoteJobTitle(job: RemoteAgentJob): string {
  if (job.title.startsWith("Recovered remote job:")) return "Restored remote session";
  if (job.title.startsWith("Resume Codex session:")) return "Resumed Codex session";
  return job.title;
}

function permissionLabel(mode: "manual" | "timeout_allow" | "always_allow"): string {
  if (mode === "timeout_allow") return "Auto-approve after 10s";
  if (mode === "always_allow") return "Always allow for this task";
  return "Ask every time";
}

export function PIWorkbench({
  initialSessions: _initialSessions,
  initialRemoteOverview,
  ideaBoard,
  projectId,
  projectName,
  projects: _projects,
  workspaceRoot,
  workspaceFiles,
}: Props) {
  const [remoteOverview, setRemoteOverview] = useState(initialRemoteOverview);
  const sessions = _initialSessions;
  const search = "";
  const [prompt, setPrompt] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [workMode, setWorkMode] = useState<"start" | "resume">("start");
  const [selectedResumeSessionId, setSelectedResumeSessionId] = useState("");
  const [permissionMode, setPermissionMode] = useState<"manual" | "timeout_allow" | "always_allow">("manual");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      void requestJson<RemoteApprovalOverview>("/api/remote-agents/overview")
        .then(setRemoteOverview)
        .catch(() => void 0);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const connectedAgents = useMemo(
    () => remoteOverview.agents.filter((agent) => agent.connectionState === "connected"),
    [remoteOverview.agents],
  );

  useEffect(() => {
    if (selectedAgentId && connectedAgents.some((agent) => agent.agentId === selectedAgentId)) return;
    setSelectedAgentId(connectedAgents[0]?.agentId ?? "");
  }, [connectedAgents, selectedAgentId]);

  const selectedAgent = connectedAgents.find((agent) => agent.agentId === selectedAgentId);
  const resumeSessions = selectedAgent?.toolType.toLowerCase().includes("codex")
    ? (selectedAgent.sessionHistory ?? [])
    : [];
  const selectedResumeSession = resumeSessions.find(
    (session) => session.sessionId === selectedResumeSessionId,
  );
  const activeJobs = remoteOverview.jobs.filter((job) => job.status === "running" || job.status === "queued");
  const pendingApprovals = remoteOverview.requests.filter((request) => request.status === "open");
  const failedJobs = remoteOverview.jobs.filter((job) => job.status === "failed");
  const savedIdeas = ideaBoard?.columns.flatMap((column) => column.ideas) ?? [];

  const _taskRows = useMemo(() => {
    const aoRows = sessions.map((session) => ({
      key: `pi-${session.id}`,
      title: session.issueTitle ?? session.summary ?? session.userPrompt ?? session.id,
      subtitle: session.status,
      status: session.piState ?? session.status,
      href: `/sessions/${encodeURIComponent(session.id)}${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
      starred: false,
    }));
    const remoteRows = remoteOverview.jobs.map((job) => ({
      key: `remote-${job.jobId}`,
      title: humanRemoteJobTitle(job),
      subtitle: `${job.status} · ${formatRelativeTime(job.updatedAt)}`,
      status: job.status,
      href: `/remote-sessions/${encodeURIComponent(job.jobId)}`,
      starred: job.status === "running",
    }));
    return [...remoteRows, ...aoRows].filter((row) =>
      `${row.title} ${row.subtitle}`.toLowerCase().includes(search.toLowerCase()),
    );
  }, [projectId, remoteOverview.jobs, search, sessions]);

  const cyclePermission = () => {
    setPermissionMode((current) =>
      current === "manual" ? "timeout_allow" : current === "timeout_allow" ? "always_allow" : "manual",
    );
  };

  useEffect(() => {
    if (selectedResumeSessionId && resumeSessions.some((session) => session.sessionId === selectedResumeSessionId)) {
      return;
    }
    setSelectedResumeSessionId(resumeSessions[0]?.sessionId ?? "");
  }, [resumeSessions, selectedResumeSessionId]);

  const handleNewTask = () => {
    setWorkMode("start");
    setPrompt("");
    setMessage(null);
    setError(null);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  };

  const startTask = () =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          setMessage(null);
          const cleanPrompt = prompt.trim();
          if (!cleanPrompt) return;

          const title = titleFromPrompt(cleanPrompt);
          const idea = await requestJson<PIIdeaBoardData>("/api/pi/ideas/board", {
            method: "POST",
            body: JSON.stringify({
              projectId,
              title,
              markdown: cleanPrompt,
            }),
          });

          if (!selectedAgent) {
            setMessage("Idea saved. Connect an agent to start implementation.");
            setPrompt("");
            return;
          }

          await requestJson("/api/remote-agents/policy", {
            method: "POST",
            body: JSON.stringify({
              agentId: selectedAgent.agentId,
              mode: permissionMode,
              timeoutSeconds: selectedAgent.timeoutSeconds,
            }),
          });

          const workspace = `${workspaceRoot.replace(/[\\/]+$/g, "")}/${safeFolderName(title)}`;
          const result = await requestJson<{ job: RemoteAgentJob }>("/api/remote-agents/jobs", {
            method: "POST",
            body: JSON.stringify({
              agentId: selectedAgent.agentId,
              provider: selectedAgent.toolType.toLowerCase().includes("claude") ? "claude" : "codex",
              cwd: workspace,
              title,
              prompt: [
                "Implement this PI task as a dedicated project.",
                `Workspace folder: ${workspace}`,
                "",
                "Use PI approval flow for risky operations. Keep work inside this folder.",
                "",
                cleanPrompt,
              ].join("\n"),
              env: {
                PI_WORKBENCH_TASK_TITLE: title,
                PI_WORKBENCH_IDEA_COUNT: String(idea.columns.flatMap((column) => column.ideas).length),
              },
            }),
          });

          setRemoteOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
          setMessage(`Started on ${selectedAgent.displayName}: ${result.job.status}`);
          setPrompt("");
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to start task");
        }
      })();
    });

  const resumeTask = () =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          setMessage(null);
          if (!selectedAgent) {
            throw new Error("Connect an agent first");
          }
          if (!selectedResumeSession) {
            throw new Error("Choose a Codex session to resume");
          }

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
              provider: "codex",
              providerArgs: ["resume", selectedResumeSession.sessionId],
              cwd: selectedResumeSession.cwd || selectedAgent.worktree || selectedAgent.repoRoot || workspaceRoot,
              title: `Resume Codex session: ${selectedResumeSession.sessionId.slice(0, 8)}`,
              env: {
                PI_RESUME_SESSION_ID: selectedResumeSession.sessionId,
                PI_RESUME_SESSION_PATH: selectedResumeSession.path,
              },
            }),
          });

          setRemoteOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
          setMessage(`Resume queued on ${selectedAgent.displayName}: ${result.job.status}`);
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to resume session");
        }
      })();
    });

  return (
    <div className="flex h-screen overflow-hidden bg-[#fbfbfa] text-[#1e2026]">
      <aside className="flex w-[84px] shrink-0 flex-col items-center border-r border-[#ececea] bg-white py-3">
        <a
          href="/"
          className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-[#9ed9e5] bg-[#0b8ea6] text-[13px] font-bold text-white shadow-sm hover:no-underline"
        >
          PI
        </a>
        <nav className="flex flex-1 flex-col items-center gap-2">
          <RailLink href="/" label="Home" active>
            +
          </RailLink>
          <RailLink href="/sessions" label="Sessions">
            =
          </RailLink>
          <RailLink href="/agents" label="Machines">
            @
          </RailLink>
          {/* <RailLink href="/ideas" label="Drafts">#</RailLink> */}
        </nav>
        <Link href="/agents" className="mb-2 text-[11px] font-semibold text-[#8a8f99] hover:no-underline">
          Help
        </Link>
      </aside>

      <aside className="hidden w-[320px] shrink-0 flex-col border-r border-[#ececea] bg-white lg:flex">
        <div className="flex h-16 items-center gap-3 border-b border-[#ececea] px-4">
          <Link href="/" className="text-[22px] text-[#7b808a] hover:no-underline">‹</Link>
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#0b8ea6] text-[11px] font-bold text-white">
            PI
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{projectName ?? "Project Interface"}</p>
            <p className="text-[11px] text-[#8b9099]">{connectedAgents.length} machine online</p>
          </div>
        </div>

        <div className="space-y-3 border-b border-[#ececea] p-4">
          <button
            type="button"
            onClick={handleNewTask}
            className="flex h-11 w-full items-center gap-3 rounded-xl bg-[#eef0f1] px-4 text-left text-[15px] font-semibold"
          >
            <span className="text-[22px] leading-none">+</span>
            Start Task
          </button>
          <div className="grid gap-2 rounded-xl border border-[#e8e8e5] bg-[#fbfbfa] p-3 text-[12px] leading-5 text-[#737882]">
            <p className="font-semibold text-[#30333a]">Next step</p>
            {connectedAgents.length === 0 ? (
              <Link href="/agents" className="font-semibold text-[#0b8ea6] hover:no-underline">
                Connect your first machine
              </Link>
            ) : pendingApprovals.length > 0 ? (
              <Link href="/sessions" className="font-semibold text-[#9a6b00] hover:no-underline">
                Open blocked session{pendingApprovals.length === 1 ? "" : "s"}
              </Link>
            ) : (
              <span>Start a task or resume a saved session.</span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.16em] text-[#a1a5ad]">
            Workspace
          </p>
          <div className="rounded-2xl border border-[#e8e8e5] bg-[#fbfbfa] p-4 text-[13px] leading-6 text-[#737882]">
            <p className="font-semibold text-[#30333a]">{projectName ?? "Project Interface"}</p>
            <p className="mt-2">{connectedAgents.length} machine{connectedAgents.length === 1 ? "" : "s"} online</p>
            <p>{activeJobs.length} session{activeJobs.length === 1 ? "" : "s"} running</p>
            <p>{pendingApprovals.length} need approval</p>
            <Link
              href="/sessions"
              className="mt-4 inline-flex rounded-full border border-[#dedfdf] px-3 py-1.5 text-[12px] font-semibold text-[#5f4fb8] hover:no-underline"
            >
              Open Sessions
            </Link>
          </div>
        </div>

        <div className="hidden">
          <Link href="/agents" className="hover:no-underline" title="Agents">⌁</Link>
          <Link href="/approval-hub" className="hover:no-underline" title="Approvals">♢</Link>
          <Link href="/ideas" className="hover:no-underline" title="Ideas">☾</Link>
          <span title="Activity">⌁</span>
        </div>

        <div className="border-t border-[#ececea]">
          <ModeIndicator />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto bg-[#fcfcfb]">
        <div className="px-8 py-8">
          <section className="mx-auto w-full max-w-[1180px]">
            {pendingApprovals.length > 0 ? (
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-[#e8c46a] bg-[#fff8e7] px-5 py-4 text-[14px]">
                <div>
                  <p className="font-semibold text-[#2c2a22]">
                    {pendingApprovals.length} task{pendingApprovals.length === 1 ? "" : "s"} need approval
                  </p>
                  <p className="mt-1 text-[13px] text-[#756232]">
                    Agents are paused until you approve, reject, or change permission mode.
                  </p>
                </div>
                <a
                  href="/sessions"
                  className="rounded-full bg-[#1e2026] px-4 py-2 text-[12px] font-semibold text-white hover:no-underline"
                >
                  Open sessions
                </a>
              </div>
            ) : null}

            <div className="mb-6 rounded-[30px] border border-[#dedfdf] bg-white p-6 shadow-[0_18px_50px_rgba(20,24,30,0.05)]">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#9aa1ad]">
                    Home
                  </p>
                  <h1 className="mt-2 text-[38px] font-semibold tracking-[-0.05em]">
                    Your coding agents
                  </h1>
                  <p className="mt-3 max-w-2xl text-[15px] leading-7 text-[#626873]">
                    Start work, resume sessions, and approve blockers from one simple control center.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <HomeStat label="Agents" value={connectedAgents.length} />
                  <HomeStat label="Running" value={activeJobs.length} />
                  <HomeStat label="Needs approval" value={pendingApprovals.length} attention={pendingApprovals.length > 0} />
                  <HomeStat label="Failed" value={failedJobs.length} danger={failedJobs.length > 0} />
                </div>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
              <div>
            <div className="mx-auto mb-8 hidden h-24 w-24 place-items-center">
              <div className="relative h-20 w-20 rounded-[22px] bg-[#f3703c] shadow-[inset_0_-10px_0_rgba(0,0,0,0.08)]">
                <div className="absolute -top-3 left-3 h-6 w-14 rounded-t-full border-[6px] border-[#143a6f] border-b-0 bg-[#e6f6ff]" />
                <div className="absolute left-5 top-6 h-1.5 w-1.5 rounded-full bg-[#15171c]" />
                <div className="absolute right-5 top-6 h-1.5 w-1.5 rounded-full bg-[#15171c]" />
                <div className="absolute -bottom-4 left-3 h-6 w-2 rounded-b bg-[#f3703c]" />
                <div className="absolute -bottom-4 left-8 h-6 w-2 rounded-b bg-[#f3703c]" />
                <div className="absolute -bottom-4 right-8 h-6 w-2 rounded-b bg-[#f3703c]" />
                <div className="absolute -bottom-4 right-3 h-6 w-2 rounded-b bg-[#f3703c]" />
              </div>
            </div>
            <h2 className="text-[24px] font-semibold tracking-[-0.03em]">
              Start work
            </h2>
            <p className="mt-2 text-[14px] leading-7 text-[#626873]">
              Pick an agent, choose permission, and describe the work.
            </p>
            <h1 className="sr-only">
              Your coding agents
            </h1>
            <div className="mx-auto mt-6 flex max-w-[560px] rounded-2xl border border-[#e2e3e4] bg-white p-1">
              <button
                type="button"
                onClick={() => {
                  setWorkMode("start");
                  window.setTimeout(() => promptRef.current?.focus(), 0);
                }}
                className={[
                  "flex-1 rounded-xl px-4 py-2.5 text-[14px] font-semibold",
                  workMode === "start" ? "bg-[#eef0f1] text-[#1e2026]" : "text-[#737882]",
                ].join(" ")}
              >
                Start new
              </button>
              <button
                type="button"
                onClick={() => setWorkMode("resume")}
                className={[
                  "flex-1 rounded-xl px-4 py-2.5 text-[14px] font-semibold",
                  workMode === "resume" ? "bg-[#eef0f1] text-[#1e2026]" : "text-[#737882]",
                ].join(" ")}
              >
                Resume session
              </button>
            </div>
            <div className="mx-auto mt-9 rounded-[28px] border border-[#dedfdf] bg-white p-4 shadow-[0_24px_60px_rgba(20,24,30,0.08)]">
              {workMode === "start" ? (
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Tell the agent what to do..."
                  className="min-h-[190px] w-full resize-none bg-transparent px-3 py-2 text-[18px] leading-8 text-[#25272d] outline-none placeholder:text-[#a7abb2]"
                />
              ) : (
                <ResumePicker
                  sessions={resumeSessions}
                  selectedSessionId={selectedResumeSessionId}
                  onSelect={setSelectedResumeSessionId}
                />
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 px-2 pb-1">
                <div className="flex flex-wrap items-center gap-3 text-[14px] text-[#626873]">
                  <button type="button" className="text-[26px] leading-none text-[#7b808a]">+</button>
                  <select
                    value={selectedAgentId}
                    onChange={(event) => setSelectedAgentId(event.target.value)}
                    className="rounded-xl border border-transparent bg-white px-2 py-2 font-medium outline-none hover:border-[#e3e4e5]"
                  >
                    {connectedAgents.length === 0 ? (
                      <option value="">No connected agent</option>
                    ) : (
                      connectedAgents.map((agent) => (
                        <option key={agent.agentId} value={agent.agentId}>
                          {agent.toolType.includes("claude") ? "Claude Code" : "Codex CLI"} · {agent.displayName}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={cyclePermission}
                    className="rounded-xl px-2 py-2 font-medium hover:bg-[#f4f5f5]"
                  >
                    Permission: {permissionLabel(permissionMode)}
                  </button>
                </div>
                <button
                  type="button"
                  disabled={
                    isPending ||
                    (workMode === "start" ? !prompt.trim() : !selectedResumeSession)
                  }
                  onClick={workMode === "start" ? startTask : resumeTask}
                  className="rounded-xl bg-[#9b9ca1] px-8 py-3 text-[15px] font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {workMode === "start" ? "Start" : "Resume"}
                </button>
              </div>
            </div>
            {message ? <p className="mt-4 text-center text-[13px] font-medium text-[#1f8c56]">{message}</p> : null}
            {error ? <p className="mt-4 text-center text-[13px] font-medium text-[#d94432]">{error}</p> : null}
            {pendingApprovals.length > 0 ? (
              <div className="mx-auto mt-5 flex max-w-[760px] items-center justify-between rounded-2xl border border-[#e8c46a] bg-[#fff8e7] px-4 py-3 text-[13px]">
                <span>{pendingApprovals.length} approval request waiting</span>
                <Link href="/sessions" className="font-semibold text-[#7b5d00] hover:no-underline">Open sessions</Link>
              </div>
            ) : null}
              </div>

              <div className="grid content-start gap-5">
                <InfoPanel title="Needs attention" count={pendingApprovals.length}>
                  {pendingApprovals.length > 0 ? (
                    pendingApprovals.slice(0, 3).map((request) => (
                      <Link
                        key={request.requestId}
                        href="/approval-hub"
                        className="block rounded-2xl border border-[#e8c46a] bg-[#fff8e7] p-4 hover:no-underline"
                      >
                        <p className="line-clamp-2 text-[14px] font-semibold text-[#25272d]">
                          {request.title}
                        </p>
                        <p className="mt-1 text-[12px] text-[#756232]">
                          Waiting {formatRelativeTime(request.createdAt)}
                        </p>
                      </Link>
                    ))
                  ) : (
                    <EmptyState>Nothing needs your attention.</EmptyState>
                  )}
                </InfoPanel>

                <InfoPanel title="Running now" count={activeJobs.length}>
                  {activeJobs.length > 0 ? (
                    activeJobs.slice(0, 4).map((job) => (
                      <Link
                        key={job.jobId}
                        href={`/remote-sessions/${encodeURIComponent(job.jobId)}`}
                        className="block rounded-2xl border border-[#e7e7e4] bg-[#fbfbfa] p-4 hover:no-underline"
                      >
                        <p className="line-clamp-2 text-[14px] font-semibold text-[#25272d]">
                          {humanRemoteJobTitle(job)}
                        </p>
                        <p className="mt-1 text-[12px] text-[#737882]">
                          {job.status} - {formatRelativeTime(job.updatedAt)}
                        </p>
                      </Link>
                    ))
                  ) : (
                    <EmptyState>No running tasks yet.</EmptyState>
                  )}
                </InfoPanel>

                <InfoPanel title="Connected machines" count={connectedAgents.length}>
                  {connectedAgents.length > 0 ? (
                    connectedAgents.slice(0, 4).map((agent) => (
                      <Link
                        key={agent.agentId}
                        href="/agents"
                        className="flex items-center justify-between rounded-2xl border border-[#e7e7e4] bg-[#fbfbfa] p-4 hover:no-underline"
                      >
                        <div>
                          <p className="text-[14px] font-semibold text-[#25272d]">{agent.displayName}</p>
                          <p className="mt-1 text-[12px] text-[#737882]">
                            {agent.toolType} - {agent.hostLabel}
                          </p>
                        </div>
                        <span className="rounded-full border border-[#25a55f] px-2.5 py-1 text-[11px] font-semibold text-[#25a55f]">
                          online
                        </span>
                      </Link>
                    ))
                  ) : (
                    <Link
                      href="/agents"
                      className="block rounded-2xl border border-dashed border-[#dedfdf] p-4 text-[13px] text-[#626873] hover:no-underline"
                    >
                      No machines connected. Connect a machine to run tasks.
                    </Link>
                  )}
                </InfoPanel>
              </div>
            </div>
          </section>
        </div>
      </main>

      <aside className="hidden w-[360px] shrink-0 border-l border-[#ececea] bg-white">
        <div className="flex h-14 items-center justify-between border-b border-[#ececea] px-5">
          <p className="text-[14px] font-semibold uppercase tracking-[0.08em] text-[#9aa1ad]">Context</p>
          <span className="text-[#9aa1ad]">↻</span>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold">
            <span className="h-5 w-1.5 rounded bg-[#7d8794]" />
            {workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace"}
          </div>
          <div className="space-y-2 text-[14px]">
            {workspaceFiles.map((name) => (
              <div key={name} className="flex items-center gap-2 text-[#444852]">
                <span className="w-4 text-[#7d8794]">{fileGlyph(name)}</span>
                <span className="truncate">{name}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="border-t border-[#ececea] p-5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#a1a5ad]">
            Context
          </p>
          <div className="mt-3 space-y-2 text-[13px] text-[#737882]">
            <p>{activeJobs.length} active remote session{activeJobs.length === 1 ? "" : "s"}</p>
            <p>{savedIdeas.length} saved idea{savedIdeas.length === 1 ? "" : "s"}</p>
            <p className="truncate">root: {workspaceRoot}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}

function RailLink({
  href,
  label,
  active = false,
  children,
}: {
  href: string;
  label: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="grid w-[64px] justify-items-center gap-1 rounded-2xl px-1 py-2 text-center text-[10px] font-semibold text-[#68707c] hover:bg-[#f4f5f5] hover:no-underline"
      aria-current={active ? "page" : undefined}
    >
      <span
        className={[
          "grid h-10 w-10 place-items-center rounded-xl border text-[12px] shadow-sm",
          active
            ? "border-[#9ed9e5] bg-[#0b8ea6] text-white"
            : "border-[#e4e4e0] bg-white text-[#4f5663]",
        ].join(" ")}
      >
        {children}
      </span>
      <span>{label}</span>
    </Link>
  );
}

function HomeStat({
  label,
  value,
  attention = false,
  danger = false,
}: {
  label: string;
  value: number;
  attention?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className={[
        "min-w-[112px] rounded-2xl border bg-[#fbfbfa] px-4 py-3",
        attention ? "border-[#e8c46a]" : danger ? "border-[#f0aaa0]" : "border-[#e7e7e4]",
      ].join(" ")}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9aa1ad]">
        {label}
      </p>
      <p className="mt-1 text-[24px] font-semibold text-[#1e2026]">{value}</p>
    </div>
  );
}

function InfoPanel({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[26px] border border-[#dedfdf] bg-white p-5 shadow-[0_18px_50px_rgba(20,24,30,0.04)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold text-[#25272d]">{title}</h2>
        <span className="rounded-full border border-[#e3e4e5] px-3 py-1 text-[12px] font-semibold text-[#737882]">
          {count}
        </span>
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#dedfdf] p-4 text-[13px] text-[#8b9099]">
      {children}
    </div>
  );
}

function ResumePicker({
  sessions,
  selectedSessionId,
  onSelect,
}: {
  sessions: RemoteAgentSessionHistoryItem[];
  selectedSessionId: string;
  onSelect: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="min-h-[190px] rounded-2xl border border-dashed border-[#dedfdf] bg-[#fbfbfa] p-5 text-[14px] leading-7 text-[#737882]">
        No resumable Codex sessions were reported by this connected machine yet.
        Open Agents to confirm the bridge is connected, or switch back to Start new.
      </div>
    );
  }

  const selected = sessions.find((session) => session.sessionId === selectedSessionId) ?? sessions[0];

  return (
    <div className="min-h-[190px] space-y-3 px-1 py-1">
      <select
        value={selected?.sessionId ?? ""}
        onChange={(event) => onSelect(event.currentTarget.value)}
        className="h-12 w-full rounded-2xl border border-[#e2e3e4] bg-white px-4 text-[14px] font-medium text-[#30333a] outline-none"
      >
        {sessions.slice(0, 12).map((session) => (
          <option key={session.sessionId} value={session.sessionId}>
            {(session.messagePreview || "No captured task").slice(0, 90)}
          </option>
        ))}
      </select>

      {selected ? (
        <div className="rounded-2xl border border-[#e2e3e4] bg-[#fbfbfa] p-4">
          <p className="line-clamp-2 text-[15px] font-semibold text-[#25272d]">
            {selected.messagePreview || "No captured task"}
          </p>
          {selected.lastActivityPreview ? (
            <p className="mt-2 line-clamp-3 text-[13px] leading-6 text-[#626873]">
              Last: {selected.lastActivityPreview}
            </p>
          ) : null}
          <div className="mt-3 grid gap-1 text-[12px] text-[#8b9099]">
            <p className="truncate">cwd: {selected.cwd ?? "unknown"}</p>
            <p className="truncate">session: {selected.sessionId}</p>
            <p>
              {selected.source ?? "codex"}
              {selected.model ? ` / ${selected.model}` : ""}
              {typeof selected.eventCount === "number" ? ` / ${selected.eventCount} events` : ""}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
