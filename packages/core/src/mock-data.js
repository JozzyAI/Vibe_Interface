import { createSession, createSessionEvent, createUserRequest, transitionSession } from "./domain.js";
import { buildGithubIssuePayloads, createQueuedSessionsFromPlan, expandIdeaToIssuePlan } from "./intake.js";

function minsAgo(n) {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

export function createMockProjectState() {
  const intakePlan = expandIdeaToIssuePlan({
    title: "PI control plane for AO",
    description:
      "Upgrade AO into a 24/7 idea factory with intake, scheduling, approvals, and recovery.",
    repo: "acme/pi",
    priority: "high",
    acceptanceCriteria: [
      "Ideas turn into GitHub issues automatically.",
      "Concurrency and rate limits are budget-aware.",
      "Agents can ask for approval and examples from the dashboard.",
      "Restore picks up from structured session context."
    ]
  });

  const queuedSessions = createQueuedSessionsFromPlan(intakePlan);
  const runningSession = transitionSession(
    createSession({
      repo: "acme/pi",
      ideaId: intakePlan.idea.id,
      issueId: intakePlan.issues[0].id,
      title: "PI control plane for AO: issue generator implementation",
      tool: "codex",
      branch: "pi/issue-generator",
      lastUpdate: "Building GitHub issue payloads from dashboard intake"
    }),
    "running",
    "Actively generating issue payloads"
  );

  const awaitingExample = transitionSession(
    createSession({
      repo: "acme/pi",
      ideaId: intakePlan.idea.id,
      issueId: intakePlan.issues[2].id,
      title: "PI control plane for AO: inbox and approvals",
      tool: "claude-code",
      branch: "pi/inbox-state-machine",
      lastUpdate: "Needs example of approval card copy"
    }),
    "awaiting_user_input",
    "Waiting for example"
  );

  const awaitingApproval = transitionSession(
    createSession({
      repo: "acme/pi",
      ideaId: intakePlan.idea.id,
      issueId: intakePlan.issues[1].id,
      title: "PI control plane for AO: scheduler and rate-limit policy",
      tool: "codex",
      branch: "pi/scheduler-budget-gates",
      prUrl: "https://github.com/acme/pi/pull/42",
      lastUpdate: "Plan ready for approval"
    }),
    "awaiting_approval",
    "Waiting for scope approval"
  );

  const blocked = transitionSession(
    createSession({
      repo: "acme/pi",
      title: "PI control plane for AO: recovery hook wiring",
      tool: "codex",
      branch: "pi/recovery-hook",
      lastUpdate: "Paused after provider rate limit",
      needsRestore: true,
      restoreAvailable: true
    }),
    "blocked",
    "Provider rate limited"
  );

  const reviewReady = transitionSession(
    createSession({
      repo: "acme/pi",
      title: "PI control plane for AO: dashboard polish",
      tool: "claude-code",
      prUrl: "https://github.com/acme/pi/pull/43",
      lastUpdate: "PR is green and waiting for merge"
    }),
    "review_ready",
    "Ready for review"
  );

  const failed = transitionSession(
    createSession({
      repo: "acme/pi",
      title: "PI control plane for AO: Telegram notifier",
      tool: "codex",
      lastUpdate: "Retry budget exhausted",
      needsRestore: true,
      restoreAvailable: true
    }),
    "failed",
    "Failed after retries"
  );

  runningSession.events = [
    createSessionEvent({ sessionId: runningSession.id, type: "session.created", summary: "Session opened from intake plan", createdAt: minsAgo(52) }),
    createSessionEvent({ sessionId: runningSession.id, type: "session.started", summary: "Codex started on branch pi/issue-generator", createdAt: minsAgo(48) }),
    createSessionEvent({ sessionId: runningSession.id, type: "session.state_changed", summary: "Parsing acceptance criteria from idea", createdAt: minsAgo(34) }),
    createSessionEvent({ sessionId: runningSession.id, type: "session.state_changed", summary: "Building GitHub issue payloads from dashboard intake", createdAt: minsAgo(11) })
  ];

  awaitingExample.events = [
    createSessionEvent({ sessionId: awaitingExample.id, type: "session.created", summary: "Session opened for inbox and approvals issue", createdAt: minsAgo(78) }),
    createSessionEvent({ sessionId: awaitingExample.id, type: "session.started", summary: "Claude Code started on branch pi/inbox-state-machine", createdAt: minsAgo(74) }),
    createSessionEvent({ sessionId: awaitingExample.id, type: "session.state_changed", summary: "Scaffolded approval card component", createdAt: minsAgo(61) }),
    createSessionEvent({ sessionId: awaitingExample.id, type: "session.waiting_input", summary: "Needs example of approval card copy from user", createdAt: minsAgo(19) })
  ];

  awaitingApproval.events = [
    createSessionEvent({ sessionId: awaitingApproval.id, type: "session.created", summary: "Session opened for scheduler issue", createdAt: minsAgo(130) }),
    createSessionEvent({ sessionId: awaitingApproval.id, type: "session.started", summary: "Codex started on branch pi/scheduler-budget-gates", createdAt: minsAgo(126) }),
    createSessionEvent({ sessionId: awaitingApproval.id, type: "session.state_changed", summary: "Implemented global concurrency cap", createdAt: minsAgo(95) }),
    createSessionEvent({ sessionId: awaitingApproval.id, type: "session.state_changed", summary: "Added provider pause handling", createdAt: minsAgo(60) }),
    createSessionEvent({ sessionId: awaitingApproval.id, type: "session.approval_requested", summary: "Plan ready — waiting for scope approval", createdAt: minsAgo(27) })
  ];

  blocked.events = [
    createSessionEvent({ sessionId: blocked.id, type: "session.created", summary: "Session opened for recovery hook wiring", createdAt: minsAgo(200) }),
    createSessionEvent({ sessionId: blocked.id, type: "session.started", summary: "Codex started on branch pi/recovery-hook", createdAt: minsAgo(196) }),
    createSessionEvent({ sessionId: blocked.id, type: "session.state_changed", summary: "Wiring session restore commands", createdAt: minsAgo(140) }),
    createSessionEvent({ sessionId: blocked.id, type: "session.failed", summary: "Paused after provider rate limit hit", createdAt: minsAgo(85) })
  ];

  reviewReady.events = [
    createSessionEvent({ sessionId: reviewReady.id, type: "session.created", summary: "Session opened for dashboard polish", createdAt: minsAgo(310) }),
    createSessionEvent({ sessionId: reviewReady.id, type: "session.started", summary: "Claude Code started on dashboard branch", createdAt: minsAgo(305) }),
    createSessionEvent({ sessionId: reviewReady.id, type: "session.state_changed", summary: "Refactored card layout and state colours", createdAt: minsAgo(240) }),
    createSessionEvent({ sessionId: reviewReady.id, type: "session.state_changed", summary: "All CI checks passed", createdAt: minsAgo(180) }),
    createSessionEvent({ sessionId: reviewReady.id, type: "session.completed", summary: "PR #43 is green and ready for merge", createdAt: minsAgo(95) })
  ];

  const requests = [
    createUserRequest({
      sessionId: awaitingExample.id,
      repo: awaitingExample.repo,
      kind: "example_request",
      title: "Need example for approval card",
      message: "Please share one real example of an agent asking for final PR approval."
    }),
    createUserRequest({
      sessionId: awaitingApproval.id,
      repo: awaitingApproval.repo,
      kind: "plan_approval",
      title: "Approve scheduler scope",
      message: "Approve the first pass with global concurrency, repo caps, and provider pause handling."
    })
  ];

  return {
    ideas: [intakePlan.idea],
    issuePlans: [intakePlan],
    issuePayloads: buildGithubIssuePayloads(intakePlan),
    sessions: [
      ...queuedSessions,
      runningSession,
      awaitingExample,
      awaitingApproval,
      blocked,
      reviewReady,
      failed
    ],
    requests
  };
}
