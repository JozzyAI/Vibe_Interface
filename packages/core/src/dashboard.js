export function buildDashboardModel({ ideas = [], issuePlans = [], sessions = [], requests = [] }) {
  const inbox = requests
    .filter((request) => request.status === "open")
    .map((request) => ({
      id: request.id,
      sessionId: request.sessionId,
      repo: request.repo,
      title: request.title,
      kind: request.kind,
      message: request.message,
      createdAt: request.createdAt
    }));

  const backlog = {
    ideas: ideas.map((idea) => ({
      id: idea.id,
      title: idea.title,
      repo: idea.repo,
      priority: idea.priority,
      source: idea.source
    })),
    issueGroups: issuePlans.map((plan) => ({
      id: plan.issueGroup.id,
      title: plan.issueGroup.title,
      repo: plan.issueGroup.repo,
      priority: plan.issueGroup.priority,
      issueCount: plan.issueGroup.issueCount
    })),
    queuedSessions: sessions
      .filter((session) => session.state === "queued")
      .map((session) => ({
        id: session.id,
        title: session.title,
        repo: session.repo,
        priority: session.priority,
        lastUpdate: session.lastUpdate
      }))
  };

  const activeAgents = sessions
    .filter((session) =>
      ["running", "awaiting_user_input", "awaiting_approval", "blocked", "review_ready"].includes(
        session.state
      )
    )
    .map((session) => ({
      id: session.id,
      title: session.title,
      repo: session.repo,
      tool: session.tool,
      state: session.state,
      lastUpdate: session.lastUpdate,
      prUrl: session.prUrl,
      budget: session.budget,
      recentEvent: (session.events ?? []).at(-1) ?? null
    }));

  const recovery = sessions
    .filter((session) => session.restoreAvailable || session.needsRestore)
    .map((session) => ({
      id: session.id,
      title: session.title,
      repo: session.repo,
      state: session.state,
      needsRestore: session.needsRestore,
      lastHeartbeatAt: session.lastHeartbeatAt,
      restoreAvailable: session.restoreAvailable
    }));

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      inbox: inbox.length,
      queued: backlog.queuedSessions.length,
      active: activeAgents.length,
      recovery: recovery.length
    },
    inbox,
    backlog,
    activeAgents,
    recovery
  };
}
