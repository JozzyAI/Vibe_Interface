import { nowIso, transitionSession } from "./domain.js";

function priorityScore(priority) {
  const map = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1
  };

  return map[priority] ?? map.medium;
}

export class BudgetScheduler {
  constructor(config = {}) {
    this.globalConcurrency = config.globalConcurrency ?? 5;
    this.repoConcurrency = config.repoConcurrency ?? {};
    this.retryDelayMs = config.retryDelayMs ?? 60_000;
    this.rateLimits = new Map();
    this.queue = [];
    this.running = new Map();
  }

  enqueue(session) {
    this.queue.push(session);
    this.queue.sort((left, right) => priorityScore(right.priority) - priorityScore(left.priority));
    return this.snapshot();
  }

  getRepoRunningCount(repo) {
    let count = 0;
    for (const session of this.running.values()) {
      if (session.repo === repo) {
        count += 1;
      }
    }
    return count;
  }

  markRateLimited(tool, until, reason = "Model provider rate limited") {
    this.rateLimits.set(tool, {
      until,
      reason
    });
  }

  clearExpiredRateLimits(now = Date.now()) {
    for (const [tool, value] of this.rateLimits.entries()) {
      if (value.until <= now) {
        this.rateLimits.delete(tool);
      }
    }
  }

  canRun(session, now = Date.now()) {
    this.clearExpiredRateLimits(now);

    if (this.running.size >= this.globalConcurrency) {
      return { ok: false, reason: "Global concurrency exhausted" };
    }

    const repoLimit = this.repoConcurrency[session.repo];
    if (repoLimit && this.getRepoRunningCount(session.repo) >= repoLimit) {
      return { ok: false, reason: `Repo concurrency exhausted for ${session.repo}` };
    }

    const rateLimit = this.rateLimits.get(session.tool);
    if (rateLimit && rateLimit.until > now) {
      return { ok: false, reason: rateLimit.reason };
    }

    return { ok: true };
  }

  promoteReadySessions(now = Date.now()) {
    const activated = [];
    const deferred = [];

    for (const session of this.queue) {
      const gate = this.canRun(session, now);
      if (gate.ok) {
        const runningSession = transitionSession(
          {
            ...session,
            lastUpdate: "Scheduler granted execution slot",
            lastHeartbeatAt: nowIso()
          },
          "running",
          "Execution started"
        );
        this.running.set(runningSession.id, runningSession);
        activated.push(runningSession);
      } else {
        deferred.push({
          ...session,
          lastUpdate: gate.reason
        });
      }
    }

    this.queue = deferred;
    return activated;
  }

  completeSession(sessionId, nextState = "review_ready", message = "Execution completed") {
    const existing = this.running.get(sessionId);
    if (!existing) {
      return null;
    }

    const completed = transitionSession(
      {
        ...existing,
        lastUpdate: message
      },
      nextState,
      message
    );

    this.running.delete(sessionId);
    return completed;
  }

  retrySession(session, reason = "Retry scheduled") {
    if (session.retryCount >= session.maxRetries) {
      return transitionSession(
        {
          ...session,
          lastUpdate: "Retry budget exhausted"
        },
        "failed",
        "Retry budget exhausted"
      );
    }

    const next = transitionSession(
      {
        ...session,
        retryCount: session.retryCount + 1,
        lastUpdate: reason
      },
      "queued",
      reason
    );

    this.enqueue(next);
    return next;
  }

  snapshot() {
    return {
      queued: this.queue.length,
      running: this.running.size,
      rateLimitedTools: Array.from(this.rateLimits.keys())
    };
  }
}
