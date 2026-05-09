import { createIdea, createIssueTask, createSession } from "./domain.js";

const PRIORITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

function splitAcceptanceCriteria(idea) {
  if (idea.acceptanceCriteria.length > 0) {
    return idea.acceptanceCriteria;
  }

  return [
    "Intake path turns the idea into one or more actionable GitHub issues.",
    "Scheduling respects concurrency limits and pauses on rate limits.",
    "Dashboard clearly shows when agents need user input or approval.",
    "Recovery metadata is saved so sessions can resume with context."
  ];
}

export function normalizeIdeaSubmission(payload = {}) {
  return createIdea({
    ...payload,
    status: "triaged",
    labels: ["pi:intake", ...(payload.labels ?? [])]
  });
}

export function expandIdeaToIssuePlan(input = {}) {
  const idea = normalizeIdeaSubmission(input);
  const acceptanceCriteria = splitAcceptanceCriteria(idea);

  const issues = [
    createIssueTask({
      title: `${idea.title}: intake and issue generation`,
      repo: idea.repo,
      priority: idea.priority,
      labels: ["pi:intake", "lane:backlog"],
      acceptanceCriteria: acceptanceCriteria.slice(0, 2),
      body: [
        `Source idea: ${idea.title}`,
        "",
        idea.description,
        "",
        "Deliverables:",
        "- Accept idea input from dashboard, API, or bot.",
        "- Expand the idea into GitHub-ready tasks with labels and priorities."
      ].join("\n")
    }),
    createIssueTask({
      title: `${idea.title}: scheduler and budget gates`,
      repo: idea.repo,
      priority: idea.priority,
      labels: ["pi:scheduler", "lane:backlog"],
      acceptanceCriteria: acceptanceCriteria.slice(1, 3),
      body: [
        `Source idea: ${idea.title}`,
        "",
        "Deliverables:",
        "- Enforce per-repo and global concurrency limits.",
        "- Pause or retry work on model rate limits.",
        "- Auto-promote backlog tasks when capacity opens."
      ].join("\n")
    }),
    createIssueTask({
      title: `${idea.title}: approvals, inbox, and recovery`,
      repo: idea.repo,
      priority: idea.priority,
      labels: ["pi:hitl", "pi:recovery", "lane:backlog"],
      acceptanceCriteria: acceptanceCriteria.slice(2),
      body: [
        `Source idea: ${idea.title}`,
        "",
        "Deliverables:",
        "- Capture user questions and approvals as first-class state.",
        "- Persist session summaries and pending questions.",
        "- Expose restore actions in the dashboard."
      ].join("\n")
    })
  ];

  return {
    idea,
    issueGroup: {
      id: `group_${idea.id}`,
      title: idea.title,
      repo: idea.repo,
      priority: idea.priority,
      rank: PRIORITY_RANK[idea.priority] ?? PRIORITY_RANK.medium,
      issueCount: issues.length
    },
    issues
  };
}

export function buildGithubIssuePayloads(plan) {
  return plan.issues.map((issue, index) => ({
    title: issue.title,
    body: issue.body,
    labels: [
      ...issue.labels,
      `priority:${issue.priority}`,
      `group:${plan.issueGroup.id}`,
      `sequence:${index + 1}`
    ],
    repo: issue.repo
  }));
}

export function createQueuedSessionsFromPlan(plan) {
  return plan.issues.map((issue, index) =>
    createSession({
      repo: issue.repo,
      ideaId: plan.idea.id,
      issueId: issue.id,
      title: issue.title,
      priority: issue.priority,
      tool: index === 0 ? "codex" : "claude-code",
      lastUpdate: "Waiting for scheduler capacity"
    })
  );
}
