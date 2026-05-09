function relTime(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error ?? "Request failed");
  }

  return response.json();
}

function renderCounts(model) {
  const root = document.querySelector("#counts");
  root.innerHTML = `
    <div class="hero-metrics">
      <div class="metric">
        <span>Inbox</span>
        <strong>${model.counts.inbox}</strong>
      </div>
      <div class="metric">
        <span>Queued</span>
        <strong>${model.counts.queued}</strong>
      </div>
      <div class="metric">
        <span>Active</span>
        <strong>${model.counts.active}</strong>
      </div>
      <div class="metric">
        <span>Recovery</span>
        <strong>${model.counts.recovery}</strong>
      </div>
    </div>
  `;

  document.querySelector("#inbox-count").textContent = `${model.counts.inbox} waiting`;
  document.querySelector("#queue-count").textContent = `${model.counts.queued} queued`;
  document.querySelector("#active-count").textContent = `${model.counts.active} live`;
  document.querySelector("#recovery-count").textContent = `${model.counts.recovery} recoverable`;
}

function renderInbox(model) {
  const root = document.querySelector("#inbox");
  if (model.inbox.length === 0) {
    root.innerHTML = `<div class="empty">No agents are waiting on you right now.</div>`;
    return;
  }

  root.innerHTML = model.inbox
    .map(
      (item) => `
        <section class="card">
          <div class="card-head">
            <div>
              <h3 class="card-title">${escapeHtml(item.title)}</h3>
              <p class="muted">${escapeHtml(item.repo)} • ${escapeHtml(item.kind)}</p>
            </div>
            <span class="tag">session ${escapeHtml(item.sessionId)}</span>
          </div>
          <p class="muted">${escapeHtml(item.message)}</p>
          <textarea id="reply-${escapeHtml(item.id)}" placeholder="Reply with context, example, or approval note..."></textarea>
          <div class="actions">
            <button class="primary" data-action="reply" data-id="${escapeHtml(item.id)}">Send reply</button>
            <button class="secondary" data-action="approve" data-id="${escapeHtml(item.id)}">Approve</button>
            <button class="ghost" data-action="reject" data-id="${escapeHtml(item.id)}">Reject</button>
          </div>
        </section>
      `
    )
    .join("");
}

function renderBacklog(model) {
  const root = document.querySelector("#backlog");
  root.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h3 class="card-title">Ideas</h3>
        <span class="tag">${model.backlog.ideas.length}</span>
      </div>
      ${
        model.backlog.ideas.length === 0
          ? `<div class="empty">No ideas captured yet.</div>`
          : model.backlog.ideas
              .map(
                (idea) => `
                  <div class="card-row">
                    <span>${escapeHtml(idea.title)}</span>
                    <span class="tag">${escapeHtml(idea.priority)} • ${escapeHtml(idea.repo)}</span>
                  </div>
                `
              )
              .join("")
      }
    </section>
    <section class="card">
      <div class="card-head">
        <h3 class="card-title">Issue Groups</h3>
        <span class="tag">${model.backlog.issueGroups.length}</span>
      </div>
      ${
        model.backlog.issueGroups.length === 0
          ? `<div class="empty">No issue groups yet.</div>`
          : model.backlog.issueGroups
              .map(
                (group) => `
                  <div class="card-row">
                    <span>${escapeHtml(group.title)}</span>
                    <span class="tag">${group.issueCount} issues • ${escapeHtml(group.priority)}</span>
                  </div>
                `
              )
              .join("")
      }
    </section>
    <section class="card">
      <div class="card-head">
        <h3 class="card-title">Queued Sessions</h3>
        <span class="tag">${model.backlog.queuedSessions.length}</span>
      </div>
      ${
        model.backlog.queuedSessions.length === 0
          ? `<div class="empty">Scheduler queue is empty.</div>`
          : model.backlog.queuedSessions
              .map(
                (session) => `
                  <div class="card-row">
                    <span>${escapeHtml(session.title)}</span>
                    <span class="tag">${escapeHtml(session.priority)} • ${escapeHtml(session.lastUpdate)}</span>
                  </div>
                `
              )
              .join("")
      }
    </section>
  `;
}

function renderActiveAgents(model) {
  const root = document.querySelector("#active-agents");
  root.innerHTML = model.activeAgents
    .map(
      (agent) => `
        <section class="card agent-card" data-session-id="${escapeHtml(agent.id)}">
          <div class="card-head">
            <div>
              <h3 class="card-title">${escapeHtml(agent.title)}</h3>
              <p class="muted">${escapeHtml(agent.repo)} • ${escapeHtml(agent.tool)}</p>
            </div>
            <span class="state state-${escapeHtml(agent.state)}">${escapeHtml(agent.state)}</span>
          </div>
          <p class="muted">${escapeHtml(agent.lastUpdate)}</p>
          ${
            agent.recentEvent
              ? `<p class="last-event">
                  <span class="event-type-label">${escapeHtml(agent.recentEvent.type)}</span>
                  <span class="muted">${escapeHtml(agent.recentEvent.summary)}</span>
                  <span class="event-rel-time">· ${relTime(agent.recentEvent.createdAt)}</span>
                </p>`
              : ""
          }
          <div class="card-row">
            <span class="tag">tokens ${agent.budget.estimatedTokens}</span>
            <span class="tag">est. $${agent.budget.estimatedUsd}</span>
            ${
              agent.prUrl
                ? `<a class="tag" href="${escapeHtml(agent.prUrl)}" target="_blank" rel="noreferrer">PR</a>`
                : `<span class="tag">No PR yet</span>`
            }
          </div>
        </section>
      `
    )
    .join("");
}

function renderSessionDetail(session) {
  const events = (session.events ?? []).slice().reverse();
  const drawer = document.querySelector("#session-detail");

  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h2 class="drawer-title">${escapeHtml(session.title)}</h2>
      </div>
      <button class="drawer-close" id="drawer-close-btn" aria-label="Close">✕</button>
    </div>
    <div class="drawer-meta">
      <span class="state state-${escapeHtml(session.state)}">${escapeHtml(session.state)}</span>
      <span>${escapeHtml(session.repo)}</span>
      <span>${escapeHtml(session.tool)}</span>
      ${session.branch ? `<span class="tag">${escapeHtml(session.branch)}</span>` : ""}
    </div>
    <p class="event-log-heading">Activity</p>
    <div class="event-log">
      ${
        events.length === 0
          ? `<p class="muted">No events recorded yet.</p>`
          : events
              .map(
                (evt) => `
                  <div class="event-item">
                    <div class="event-dot"></div>
                    <div class="event-body">
                      <p class="event-summary">${escapeHtml(evt.summary)}</p>
                      <div class="event-footer">
                        <span class="event-type-label">${escapeHtml(evt.type)}</span>
                        <span class="event-rel-time">${relTime(evt.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                `
              )
              .join("")
      }
    </div>
  `;

  drawer.classList.add("open");
  document.querySelector("#detail-overlay").classList.add("open");

  document.querySelector("#drawer-close-btn").addEventListener("click", closeSessionDetail);
}

function closeSessionDetail() {
  document.querySelector("#session-detail").classList.remove("open");
  document.querySelector("#detail-overlay").classList.remove("open");
}

async function openSessionDetail(sessionId) {
  try {
    const { session } = await request(`/api/sessions/${sessionId}`);
    renderSessionDetail(session);
  } catch (error) {
    window.alert(error.message);
  }
}

function renderRecovery(model) {
  const root = document.querySelector("#recovery");
  if (model.recovery.length === 0) {
    root.innerHTML = `<div class="empty">No interrupted sessions to restore.</div>`;
    return;
  }

  root.innerHTML = model.recovery
    .map(
      (item) => `
        <section class="card">
          <div class="card-head">
            <div>
              <h3 class="card-title">${escapeHtml(item.title)}</h3>
              <p class="muted">${escapeHtml(item.repo)}</p>
            </div>
            <span class="state state-${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
          </div>
          <div class="card-row">
            <span class="tag">${item.needsRestore ? "Needs restore" : "Healthy archive"}</span>
            <span class="tag">${new Date(item.lastHeartbeatAt).toLocaleString()}</span>
          </div>
          <div class="actions">
            <button class="primary" data-action="restore" data-id="${escapeHtml(item.id)}">Restore session</button>
          </div>
        </section>
      `
    )
    .join("");
}

async function refresh() {
  const model = await request("/api/dashboard");
  renderCounts(model);
  renderInbox(model);
  renderBacklog(model);
  renderActiveAgents(model);
  renderRecovery(model);
}

document.addEventListener("click", async (event) => {
  if (event.target.id === "detail-overlay") {
    closeSessionDetail();
    return;
  }

  const button = event.target.closest("button[data-action]");
  if (button) {
    const action = button.dataset.action;
    const id = button.dataset.id;

    try {
      if (action === "reply") {
        const textarea = document.querySelector(`#reply-${id}`);
        await request(`/api/requests/${id}/reply`, {
          method: "POST",
          body: JSON.stringify({ message: textarea.value })
        });
      }

      if (action === "approve" || action === "reject") {
        const textarea = document.querySelector(`#reply-${id}`);
        await request(`/api/requests/${id}/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: action, message: textarea.value })
        });
      }

      if (action === "restore") {
        await request(`/api/sessions/${id}/restore`, {
          method: "POST",
          body: JSON.stringify({})
        });
      }

      await refresh();
    } catch (error) {
      window.alert(error.message);
    }
    return;
  }

  const card = event.target.closest("[data-session-id]");
  if (card) {
    openSessionDetail(card.dataset.sessionId);
  }
});

refresh().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.message)}</pre>`;
});
