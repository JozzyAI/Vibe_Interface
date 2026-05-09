"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { PIApprovalHubData, PIApprovalInboxEntry } from "@/lib/types";
import type { NativeCodexApproval } from "@/lib/native-codex-approval";

interface Props {
  projectId: string;
  sessionId: string;
}

interface NativeApprovalPayload {
  sessionId: string;
  tmuxName: string;
  approval: NativeCodexApproval | null;
  capturedAt: string;
}

const inputClassName =
  "mt-3 min-h-[88px] w-full rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-3 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]";

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

function riskTone(risk: string): string {
  switch (risk) {
    case "critical":
      return "border-[var(--color-accent-red)] text-[var(--color-accent-red)]";
    case "high":
      return "border-[var(--color-status-attention)] text-[var(--color-status-attention)]";
    case "medium":
      return "border-[var(--color-accent)] text-[var(--color-accent)]";
    default:
      return "border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)]";
  }
}

function eventLabel(eventType: PIApprovalInboxEntry["context"]["eventType"]): string {
  switch (eventType) {
    case "network_access":
      return "Network access";
    case "dependency_install":
      return "Dependency install";
    case "git_push":
      return "Git push";
    case "delete_operation":
      return "Delete operation";
    case "scope_clarification":
      return "Reply required";
    case "example_request":
      return "Example required";
    case "plan_approval":
      return "Plan approval";
    case "final_approval":
      return "Final approval";
    default:
      return "Agent request";
  }
}

function primaryButtonLabel(request: PIApprovalInboxEntry): string {
  return request.context.primaryAction === "reply" ? "Send reply" : "Approve";
}

export function SessionApprovalPanel({ projectId, sessionId }: Props) {
  const [requests, setRequests] = useState<PIApprovalInboxEntry[]>([]);
  const [nativeApproval, setNativeApproval] = useState<NativeCodexApproval | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const hubUrl = useMemo(
    () => `/api/pi/approval-hub?project=${encodeURIComponent(projectId)}`,
    [projectId],
  );

  const refresh = async () => {
    const [latest, native] = await Promise.all([
      requestJson<PIApprovalHubData>(hubUrl),
      requestJson<NativeApprovalPayload>(`/api/sessions/${encodeURIComponent(sessionId)}/native-approval`),
    ]);
    setRequests(latest.inbox.filter((item) => item.sessionId === sessionId));
    setNativeApproval(native.approval);
  };

  useEffect(() => {
    void refresh().catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : "Failed to load approvals");
    });
  }, [hubUrl, sessionId]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh().catch(() => void 0);
    }, 15000);
    return () => clearInterval(interval);
  }, [hubUrl, sessionId]);

  const respond = (
    requestId: string,
    action: "approve" | "reject" | "reply",
    request: PIApprovalInboxEntry,
  ) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          await requestJson("/api/pi/requests/respond", {
            method: "POST",
            body: JSON.stringify({
              sessionId: request.sessionId,
              requestId,
              action,
              response: replyDrafts[requestId] ?? "",
              kind: request.kind,
              title: request.title,
              message: request.message,
            }),
          });
          setReplyDrafts((current) => ({ ...current, [requestId]: "" }));
          await refresh();
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to send response");
        }
      })();
    });

  const alwaysApprove = (request: PIApprovalInboxEntry) =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          await requestJson("/api/pi/approval-hub/policy", {
            method: "POST",
            body: JSON.stringify({
              projectId,
              sessionId: request.sessionId,
              mode: "always_allow",
              timeoutSeconds: request.timeoutSeconds,
            }),
          });
          await requestJson("/api/pi/requests/respond", {
            method: "POST",
            body: JSON.stringify({
              sessionId: request.sessionId,
              requestId: request.requestId,
              action: "approve",
              response: replyDrafts[request.requestId] ?? "",
              kind: request.kind,
              title: request.title,
              message: request.message,
            }),
          });
          setReplyDrafts((current) => ({ ...current, [request.requestId]: "" }));
          await refresh();
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Failed to enable always approve");
        }
      })();
    });

  const respondNative = (action: "approve" | "always_approve" | "reject") =>
    startTransition(() => {
      void (async () => {
        try {
          setError(null);
          await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/native-approval`, {
            method: "POST",
            body: JSON.stringify({ action }),
          });
          await refresh();
        } catch (nextError) {
          setError(
            nextError instanceof Error ? nextError.message : "Failed to respond to native approval",
          );
        }
      })();
    });

  if (requests.length === 0 && !nativeApproval && !error) return null;

  return (
    <section className="mt-5 rounded-[28px] border border-[var(--color-status-attention)]/35 bg-[var(--color-status-attention-soft)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-status-attention)]">
            Approval Request
          </p>
          <h2 className="mt-1 text-[18px] font-semibold text-[var(--color-text-primary)]">
            {nativeApproval
              ? "Codex CLI is waiting for your approval"
              : requests.length === 0
                ? "This session has no open approval requests right now"
                : "This session is waiting for your approval"}
          </h2>
        </div>
        {nativeApproval || requests.length > 0 ? (
          <span className="rounded-full border border-[var(--color-status-attention)]/35 px-3 py-1 text-[11px] font-semibold text-[var(--color-status-attention)]">
            {(nativeApproval ? 1 : 0) + requests.length} open
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-4 rounded-2xl border border-[var(--color-accent-red)]/35 bg-[var(--color-accent-red-soft)] p-3 text-[13px] text-[var(--color-accent-red)]">
          {error}
        </div>
      ) : null}

      {nativeApproval ? (
        <div className="mt-4 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold text-[var(--color-text-primary)]">
                {nativeApproval.title}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-full border border-[var(--color-status-attention)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-status-attention)]">
                  command approval
                </span>
                {nativeApproval.command ? (
                  <span className="rounded-full border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                    {nativeApproval.command}
                  </span>
                ) : null}
              </div>
            </div>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">live</span>
          </div>

          {nativeApproval.reason ? (
            <p className="mt-3 text-[13px] leading-7 text-[var(--color-text-secondary)]">
              {nativeApproval.reason}
            </p>
          ) : null}

          <pre className="mt-3 overflow-x-auto rounded-2xl bg-[var(--color-bg-base)] px-4 py-3 text-[12px] leading-6 text-[var(--color-text-primary)]">
            {nativeApproval.prompt}
          </pre>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => respondNative("approve")}
              className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => respondNative("always_approve")}
              className="rounded-full border border-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Always approve
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => respondNative("reject")}
              className="rounded-full border border-[var(--color-accent-red)] px-4 py-2 text-[12px] font-semibold text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}

      {requests.length > 0 ? (
        <div className="mt-4 grid gap-3">
          {requests.map((request) => (
            <div
              key={request.requestId}
              className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[15px] font-semibold text-[var(--color-text-primary)]">
                    {request.title}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${riskTone(request.riskLevel)}`}>
                      {request.riskLevel}
                    </span>
                    <span className="rounded-full border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                      {eventLabel(request.context.eventType)}
                    </span>
                    <span className="rounded-full border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                      {request.actionLabel}
                    </span>
                  </div>
                </div>
                <span className="text-[11px] text-[var(--color-text-tertiary)]">
                  {formatRelativeTime(request.createdAt)}
                </span>
              </div>

              <p className="mt-3 text-[13px] leading-7 text-[var(--color-text-secondary)]">
                {request.message}
              </p>

              {request.context.command || request.nativeCommand ? (
                <pre className="mt-3 overflow-x-auto rounded-2xl bg-[var(--color-bg-base)] px-4 py-3 text-[12px] leading-6 text-[var(--color-text-primary)]">
                  {request.context.command ?? request.nativeCommand}
                </pre>
              ) : null}

              {request.context.repoRoot || request.context.worktree || request.context.branch ? (
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[var(--color-text-tertiary)]">
                  {request.context.toolType ? (
                    <span className="rounded-full border border-[var(--color-border-subtle)] px-2.5 py-1">
                      {request.context.toolType}
                    </span>
                  ) : null}
                  {request.context.branch ? (
                    <span className="rounded-full border border-[var(--color-border-subtle)] px-2.5 py-1">
                      {request.context.branch}
                    </span>
                  ) : null}
                  {request.context.worktree ? (
                    <span className="rounded-full border border-[var(--color-border-subtle)] px-2.5 py-1">
                      {request.context.worktree}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <textarea
                value={replyDrafts[request.requestId] ?? ""}
                onChange={(event) =>
                  setReplyDrafts((current) => ({
                    ...current,
                    [request.requestId]: event.target.value,
                  }))
                }
                placeholder="Optional note back to the agent."
                className={inputClassName}
              />

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={
                    isPending ||
                    (request.context.primaryAction === "reply" &&
                      !(replyDrafts[request.requestId] ?? "").trim())
                  }
                  onClick={() =>
                    respond(
                      request.requestId,
                      request.context.primaryAction === "reply" ? "reply" : "approve",
                      request,
                    )
                  }
                  className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {primaryButtonLabel(request)}
                </button>
                {request.context.primaryAction === "approve" ? (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => alwaysApprove(request)}
                    className="rounded-full border border-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Always approve
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => respond(request.requestId, "approve", request)}
                    className="rounded-full border border-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Approve anyway
                  </button>
                )}
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => respond(request.requestId, "reject", request)}
                  className="rounded-full border border-[var(--color-accent-red)] px-4 py-2 text-[12px] font-semibold text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Reject
                </button>
                {request.context.primaryAction === "approve" ? (
                  <button
                    type="button"
                    disabled={isPending || !(replyDrafts[request.requestId] ?? "").trim()}
                    onClick={() => respond(request.requestId, "reply", request)}
                    className="rounded-full border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Send reply
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
