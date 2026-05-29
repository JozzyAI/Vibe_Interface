"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type {
  VIIdeaBoardData,
  VIIdeaCard,
  VIIdeaStatus,
  RemoteAgentJob,
  RemoteAgentSummary,
  RemoteApprovalOverview,
} from "@/lib/types";
import { useOverviewPolling } from "@/hooks/useOverviewPolling";

interface Props {
  initialData?: VIIdeaBoardData;
  initialRemoteOverview?: RemoteApprovalOverview;
  projectId?: string;
  executionRoot?: string;
  mode?: "compact" | "full";
}

type ColumnsPayload = Record<VIIdeaStatus, string[]>;
type RemoteProvider = "codex" | "claude";

const cardShell = "rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]";
const input = "rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]";
const COLUMN_ORDER: VIIdeaStatus[] = ["idea_bank", "project_queue", "working", "done"];

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

function buildColumnsPayload(board: VIIdeaBoardData): ColumnsPayload {
  return {
    idea_bank: board.columns.find((column) => column.id === "idea_bank")?.ideas.map((idea) => idea.id) ?? [],
    project_queue: board.columns.find((column) => column.id === "project_queue")?.ideas.map((idea) => idea.id) ?? [],
    working: board.columns.find((column) => column.id === "working")?.ideas.map((idea) => idea.id) ?? [],
    done: board.columns.find((column) => column.id === "done")?.ideas.map((idea) => idea.id) ?? [],
  };
}

function moveIdea(
  board: VIIdeaBoardData,
  ideaId: string,
  targetColumn: VIIdeaStatus,
  beforeIdeaId?: string,
): VIIdeaBoardData {
  const cloned = board.columns.map((column) => ({
    ...column,
    ideas: [...column.ideas],
  }));

  let movingIdea: VIIdeaCard | null = null;
  for (const column of cloned) {
    const index = column.ideas.findIndex((idea) => idea.id === ideaId);
    if (index >= 0) {
      movingIdea = {
        ...column.ideas[index],
        status: targetColumn,
      };
      column.ideas.splice(index, 1);
      break;
    }
  }

  if (!movingIdea) return board;
  const target = cloned.find((column) => column.id === targetColumn);
  if (!target) return board;

  const insertAt = beforeIdeaId
    ? target.ideas.findIndex((idea) => idea.id === beforeIdeaId)
    : -1;

  if (insertAt >= 0) {
    target.ideas.splice(insertAt, 0, movingIdea);
  } else {
    target.ideas.push(movingIdea);
  }

  return {
    ...board,
    generatedAt: new Date().toISOString(),
    columns: cloned,
  };
}

function findIdea(board: VIIdeaBoardData | undefined, ideaId: string | null): VIIdeaCard | null {
  if (!board || !ideaId) return null;
  for (const column of board.columns) {
    const match = column.ideas.find((idea) => idea.id === ideaId);
    if (match) return match;
  }
  return null;
}

function formatIdeaTimestamp(iso: string): string {
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(diffMinutes) || diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function safeProjectFolderName(title: string, ideaId: string): string {
  const forbiddenPathChars = '\\/:*?"<>|#%{}[]^~`';
  const cleaned = title
    .trim()
    .normalize("NFKC")
    .split("")
    .map((char) => (forbiddenPathChars.includes(char) ? " " : char))
    .join("")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return cleaned || `idea-${ideaId.slice(0, 8)}`;
}

function joinWorkspace(root: string | undefined, idea: VIIdeaCard): string {
  const base = (root?.trim() || "/srv/pi/workspaces").replace(/[\\/]+$/g, "");
  return `${base}/${safeProjectFolderName(idea.title, idea.id)}`;
}

function providerForAgent(agent?: RemoteAgentSummary): RemoteProvider {
  return agent?.toolType?.toLowerCase().includes("claude") ? "claude" : "codex";
}

function buildIdeaPrompt(idea: VIIdeaCard, workspace: string): string {
  return [
    `[VI_IDEA_ID:${idea.id}]`,
    `[VI_IDEA_TITLE:${idea.title}]`,
    "",
    "Implement this idea as a dedicated project.",
    `Workspace folder: ${workspace}`,
    "",
    "Rules:",
    "- Work inside this workspace folder. If it is empty, initialize the project there.",
    "- Create files/folders needed for an MVP implementation.",
    "- Use the normal approval flow before risky commands, dependency installs, network access, git push, or destructive changes.",
    "- Keep a short implementation summary and verification result at the end.",
    "",
    "Idea markdown:",
    idea.markdown,
  ].join("\n");
}

export function VIIdeaBoard({
  initialData,
  initialRemoteOverview,
  projectId,
  executionRoot,
  mode = "compact",
}: Props) {
  const [board, setBoard] = useState<VIIdeaBoardData | undefined>(initialData);
  const [remoteOverview, setRemoteOverview] = useState<RemoteApprovalOverview | undefined>(
    initialRemoteOverview,
  );
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [selectedIdeaId, setSelectedIdeaId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [deliveryMessage, setDeliveryMessage] = useState<string | null>(null);
  const [deliveryIdeaId, setDeliveryIdeaId] = useState<string | null>(null);
  const [draggingIdeaId, setDraggingIdeaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedIdea = useMemo(() => findIdea(board, selectedIdeaId), [board, selectedIdeaId]);
  const boardUrl = projectId
    ? `/api/vi/ideas/board?project=${encodeURIComponent(projectId)}`
    : "/api/vi/ideas/board";

  const refresh = async () => {
    setBoard(await requestJson<VIIdeaBoardData>(boardUrl));
  };
  const refreshRemoteOverview = async () => {
    setRemoteOverview(await requestJson<RemoteApprovalOverview>("/api/remote-agents/overview"));
  };

  useEffect(() => {
    setBoard(initialData);
  }, [initialData]);

  useEffect(() => {
    setRemoteOverview(initialRemoteOverview);
  }, [initialRemoteOverview]);

  useEffect(() => {
    if (!selectedIdea) return;
    setTitle(selectedIdea.title);
    setMarkdown(selectedIdea.markdown);
  }, [selectedIdea]);

  // Board data (local API) keeps its own interval; overview uses shared hook
  useEffect(() => {
    const id = setInterval(() => void refresh().catch(() => void 0), 15_000);
    return () => clearInterval(id);
  }, [boardUrl]);

  useOverviewPolling({ level: 1, slim: true, onData: setRemoteOverview });

  const connectedAgents = useMemo(
    () =>
      remoteOverview?.agents.filter(
        (agent) => agent.connectionState === "connected" && agent.status !== "failed",
      ) ?? [],
    [remoteOverview],
  );

  useEffect(() => {
    if (selectedAgentId && connectedAgents.some((agent) => agent.agentId === selectedAgentId)) {
      return;
    }
    setSelectedAgentId(connectedAgents[0]?.agentId ?? "");
  }, [connectedAgents, selectedAgentId]);

  const persistColumns = (nextBoard: VIIdeaBoardData) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          setBoard(nextBoard);
          const latest = await requestJson<VIIdeaBoardData>("/api/vi/ideas/board", {
            method: "PATCH",
            body: JSON.stringify({
                projectId,
                columns: buildColumnsPayload(nextBoard),
              }),
          });
          setBoard(latest);
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to move idea");
          await refresh().catch(() => void 0);
        }
      })();
    });

  const saveIdea = () =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          const payload =
            selectedIdeaId && selectedIdea
              ? {
                  action: "update",
                  projectId,
                  ideaId: selectedIdeaId,
                  title,
                  markdown,
                }
              : {
                  projectId,
                  title,
                  markdown,
                };

          const nextBoard = await requestJson<VIIdeaBoardData>("/api/vi/ideas/board", {
            method: selectedIdeaId && selectedIdea ? "PATCH" : "POST",
            body: JSON.stringify(payload),
          });
          setBoard(nextBoard);
          setSelectedIdeaId(null);
          setTitle("");
          setMarkdown("");
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to save idea");
        }
      })();
    });

  const openIdea = (idea: VIIdeaCard) => {
    if (mode !== "full") return;
    setSelectedIdeaId(idea.id);
    setTitle(idea.title);
    setMarkdown(idea.markdown);
  };

  const resetEditor = () => {
    setSelectedIdeaId(null);
    setTitle("");
    setMarkdown("");
  };

  const ideasFor = (status: VIIdeaStatus): VIIdeaCard[] =>
    board?.columns.find((column) => column.id === status)?.ideas ?? [];

  const unqueueIdea = (idea: VIIdeaCard) => {
    if (!board) return;
    persistColumns(moveIdea(board, idea.id, "idea_bank"));
  };

  const sendIdeaToAgent = (idea: VIIdeaCard) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          setDeliveryMessage(null);
          setDeliveryIdeaId(idea.id);
          const agent = connectedAgents.find((entry) => entry.agentId === selectedAgentId);
          if (!agent) {
            throw new Error("No connected agent selected");
          }
          const cwd = joinWorkspace(executionRoot, idea);
          const provider = providerForAgent(agent);
          const result = await requestJson<{ job: RemoteAgentJob }>("/api/remote-agents/jobs", {
            method: "POST",
            body: JSON.stringify({
              agentId: agent.agentId,
              provider,
              cwd,
              title: `Implement idea: ${idea.title}`,
              prompt: buildIdeaPrompt(idea, cwd),
              env: {
                VI_IDEA_ID: idea.id,
                VI_IDEA_TITLE: idea.title,
                VI_IDEA_WORKSPACE: cwd,
              },
            }),
          });
          setDeliveryMessage(`Sent to ${agent.displayName}. Job ${result.job.status}.`);
          if (board) {
            persistColumns(moveIdea(board, idea.id, "working"));
          }
          await refreshRemoteOverview().catch(() => void 0);
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to send idea to agent");
        } finally {
          setDeliveryIdeaId(null);
        }
      })();
    });

  return (
    <section className="mb-8 grid gap-4">
      <div className={`${cardShell} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Idea Notebook
            </p>
            <h2 className="mt-1 text-[20px] font-semibold text-[var(--color-text-primary)]">
              Write an idea, then send it to one connected agent
            </h2>
            <p className="mt-2 max-w-3xl text-[12px] leading-6 text-[var(--color-text-secondary)]">
              The title becomes the project folder name under <code>{executionRoot ?? "/srv/pi/workspaces"}</code>.
              VI starts a fresh remote job for the selected agent when you send the idea.
            </p>
          </div>
          <div className="flex gap-2">
            {mode === "compact" ? (
              <a
                href={projectId ? `/ideas?project=${encodeURIComponent(projectId)}` : "/ideas"}
                className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white hover:no-underline"
              >
                Open Idea Studio
              </a>
            ) : (
              <button
                type="button"
                onClick={resetEditor}
                className="rounded-full border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
              >
                New draft
              </button>
            )}
          </div>
        </div>
      </div>

      {mode === "full" ? (
        <div className="grid gap-4 xl:grid-cols-[0.95fr_1.35fr]">
          <article className={`${cardShell} p-5`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  Markdown
                </p>
                <h3 className="mt-1 text-[18px] font-semibold text-[var(--color-text-primary)]">
                  {selectedIdea ? "Edit idea" : "New idea"}
                </h3>
              </div>
              {selectedIdea ? (
                <span className="rounded-full border border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                  {selectedIdea.status.replaceAll("_", " ")}
                </span>
              ) : null}
            </div>
            <div className="mt-4 grid gap-3">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Idea title"
                className={input}
              />
              <textarea
                value={markdown}
                onChange={(event) => setMarkdown(event.target.value)}
                placeholder={"Write the idea in markdown.\n\nProblem\n- ...\n\nOutcome\n- ..."}
                className={`${input} min-h-[300px] font-mono`}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveIdea}
                disabled={isPending || !title.trim() || !markdown.trim()}
                className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {selectedIdea ? "Save changes" : "Save idea"}
              </button>
              {selectedIdea ? (
                <button
                  type="button"
                  onClick={resetEditor}
                  className="rounded-full border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
                >
                  Stop editing
                </button>
              ) : null}
              <a
                href="/agents"
                className="rounded-full border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-primary)] hover:no-underline"
              >
                Agents Connector
              </a>
            </div>
          </article>

          <div className="grid gap-4">
            <article className={`${cardShell} p-5`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    Saved Ideas
                  </p>
                  <h3 className="mt-1 text-[18px] font-semibold text-[var(--color-text-primary)]">
                    Ready when you are
                  </h3>
                </div>
                <span className="rounded-full border border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                  {ideasFor("idea_bank").length}
                </span>
              </div>
              <div className="mt-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                      Delivery target
                    </p>
                    <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                      {connectedAgents.length > 0
                        ? `${connectedAgents.length} connected agent${connectedAgents.length === 1 ? "" : "s"} available`
                        : "No connected agents yet"}
                    </p>
                  </div>
                  <a
                    href="/agents"
                    className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)] hover:no-underline"
                  >
                    Connect agents
                  </a>
                </div>
                {connectedAgents.length > 0 ? (
                  <select
                    value={selectedAgentId}
                    onChange={(event) => setSelectedAgentId(event.target.value)}
                    className={`${input} mt-3 w-full`}
                  >
                    {connectedAgents.map((agent) => (
                      <option key={agent.agentId} value={agent.agentId}>
                        {agent.displayName} / {agent.toolType} / {agent.hostLabel}
                      </option>
                    ))}
                  </select>
                ) : null}
                {deliveryMessage ? (
                  <p className="mt-3 text-[12px] font-medium text-[var(--color-status-success)]">
                    {deliveryMessage}
                  </p>
                ) : null}
              </div>
              <IdeaCardList
                ideas={ideasFor("idea_bank")}
                emptyText="No saved ideas yet. Write one on the left."
                primaryActionLabel="Send to agent"
                onPrimaryAction={sendIdeaToAgent}
                onOpenIdea={openIdea}
                connectedAgents={connectedAgents}
                executionRoot={executionRoot}
                isDelivering={isPending}
                deliveryIdeaId={deliveryIdeaId}
              />
            </article>

            <article className={`${cardShell} p-5`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    Run Queue
                  </p>
                  <h3 className="mt-1 text-[18px] font-semibold text-[var(--color-text-primary)]">
                    Already sent
                  </h3>
                </div>
                <span className="rounded-full border border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                  {ideasFor("project_queue").length + ideasFor("working").length}
                </span>
              </div>
              <IdeaCardList
                ideas={[...ideasFor("working"), ...ideasFor("project_queue")]}
                emptyText="Queue is empty."
                primaryActionLabel="Back to ideas"
                onPrimaryAction={unqueueIdea}
                onOpenIdea={openIdea}
                connectedAgents={connectedAgents}
                executionRoot={executionRoot}
              />
            </article>
          </div>
        </div>
      ) : (
        <IdeaColumns
          board={board}
          mode={mode}
          draggingIdeaId={draggingIdeaId}
          onDragStart={setDraggingIdeaId}
          onDragEnd={() => setDraggingIdeaId(null)}
          onDropIdea={(targetColumn, beforeIdeaId) => {
            if (!board || !draggingIdeaId) return;
            persistColumns(moveIdea(board, draggingIdeaId, targetColumn, beforeIdeaId));
            setDraggingIdeaId(null);
          }}
          onOpenIdea={openIdea}
        />
      )}

      {error ? (
        <div className="rounded-2xl border border-[color-mix(in_srgb,var(--color-status-error)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-status-error)_8%,transparent)] px-4 py-3 text-[12px] text-[var(--color-status-error)]">
          {error}
        </div>
      ) : null}
    </section>
  );
}

function IdeaCardList(props: {
  ideas: VIIdeaCard[];
  emptyText: string;
  primaryActionLabel: string;
  onPrimaryAction: (idea: VIIdeaCard) => void;
  onOpenIdea: (idea: VIIdeaCard) => void;
  connectedAgents?: RemoteAgentSummary[];
  executionRoot?: string;
  isDelivering?: boolean;
  deliveryIdeaId?: string | null;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  if (props.ideas.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-[var(--color-border-default)] px-4 py-5 text-[12px] text-[var(--color-text-tertiary)]">
        {props.emptyText}
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-3">
      {props.ideas.map((idea) => (
        <article
          key={idea.id}
          className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
                {idea.title}
              </h4>
              <p className="mt-1 text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                {idea.status.replaceAll("_", " ")} / updated {formatIdeaTimestamp(idea.updatedAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => props.onOpenIdea(idea)}
                className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => props.onPrimaryAction(idea)}
                disabled={
                  props.primaryActionLabel === "Send to agent" &&
                  ((props.connectedAgents?.length ?? 0) === 0 ||
                    props.isDelivering ||
                    props.deliveryIdeaId === idea.id)
                }
                className="rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-white"
              >
                {props.deliveryIdeaId === idea.id ? "Sending..." : props.primaryActionLabel}
              </button>
              {props.secondaryHref && props.secondaryLabel ? (
                <a
                  href={props.secondaryHref}
                  className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)] hover:no-underline"
                >
                  {props.secondaryLabel}
                </a>
              ) : null}
            </div>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-[12px] leading-6 text-[var(--color-text-secondary)]">
            {idea.excerpt || idea.markdown.slice(0, 180) || "No notes yet."}
          </p>
          {props.primaryActionLabel === "Send to agent" ? (
            <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
              Project folder: {joinWorkspace(props.executionRoot, idea)}
            </p>
          ) : null}
          {idea.sessionId ? (
            <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
              session/{idea.sessionId}
              {idea.sessionStatus ? ` / ${idea.sessionStatus}` : ""}
            </p>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function IdeaColumns(props: {
  board?: VIIdeaBoardData;
  mode: "compact" | "full";
  draggingIdeaId: string | null;
  onDragStart: (ideaId: string) => void;
  onDragEnd: () => void;
  onDropIdea: (targetColumn: VIIdeaStatus, beforeIdeaId?: string) => void;
  onOpenIdea: (idea: VIIdeaCard) => void;
}) {
  if (!props.board) {
    return (
      <div className={`${cardShell} p-5 text-[12px] text-[var(--color-text-tertiary)]`}>
        Loading idea board...
      </div>
    );
  }

  return (
    <div className={`grid gap-4 ${props.mode === "compact" ? "xl:grid-cols-4" : "xl:grid-cols-4"}`}>
      {COLUMN_ORDER.map((columnId) => {
        const column = props.board?.columns.find((entry) => entry.id === columnId);
        if (!column) return null;

        return (
          <article
            key={column.id}
            className={`${cardShell} min-h-[280px] p-4`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              props.onDropIdea(column.id);
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  {column.title}
                </div>
                <div className="mt-2 text-[11px] leading-5 text-[var(--color-text-tertiary)]">
                  {column.description}
                </div>
              </div>
              <span className="rounded-full border border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                {column.ideas.length}
              </span>
            </div>
            <div className="mt-4 grid gap-3">
              {column.ideas.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--color-border-default)] px-3 py-4 text-[12px] text-[var(--color-text-tertiary)]">
                  Drop an idea here.
                </div>
              ) : (
                column.ideas.map((idea) => (
                  <button
                    key={idea.id}
                    type="button"
                    draggable
                    onClick={() => props.onOpenIdea(idea)}
                    onDragStart={() => props.onDragStart(idea.id)}
                    onDragEnd={props.onDragEnd}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      props.onDropIdea(column.id, idea.id);
                    }}
                    className={`rounded-2xl border px-3 py-3 text-left transition ${props.draggingIdeaId === idea.id ? "border-[var(--color-accent)] opacity-60" : "border-[var(--color-border-default)] bg-[var(--color-bg-base)] hover:border-[var(--color-accent)]"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                          {idea.title}
                        </div>
                        {idea.sessionId ? (
                          <div className="mt-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                            session/{idea.sessionId}
                            {idea.sessionStatus ? ` · ${idea.sessionStatus}` : ""}
                          </div>
                        ) : null}
                      </div>
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">
                        {formatIdeaTimestamp(idea.updatedAt)}
                      </span>
                    </div>
                    <div className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-[var(--color-text-secondary)]">
                      {idea.excerpt || idea.markdown.slice(0, 180) || "No notes yet."}
                    </div>
                  </button>
                ))
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
