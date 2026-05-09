import { buildDashboardModel } from "./dashboard.js";
import { createMockProjectState } from "./mock-data.js";
import { FileContextStore } from "./persistence.js";
import { BudgetScheduler } from "./scheduler.js";

async function run() {
  const state = createMockProjectState();
  const scheduler = new BudgetScheduler({
    globalConcurrency: 2,
    repoConcurrency: {
      "acme/pi": 2
    }
  });

  for (const session of state.sessions.filter((item) => item.state === "queued")) {
    scheduler.enqueue(session);
  }

  scheduler.markRateLimited("claude-code", Date.now() + 15 * 60_000, "Claude provider cooling down");
  const activated = scheduler.promoteReadySessions();

  const store = new FileContextStore();
  if (state.sessions.length > 0) {
    await store.writeHandoff(state.sessions[0], {
      currentGoal: "Translate raw dashboard ideas into GitHub issue groups and queue sessions.",
      completed: [
        "- Built the first issue expansion pass.",
        "- Added budget-aware scheduling guards."
      ],
      diffAndTests: [
        "- Prototype only, no external AO process invoked yet.",
        "- Local demo validates dashboard model generation."
      ],
      blockers: [
        "- Waiting to wire generated commands into the real AO CLI.",
        "- Need GitHub token plumbing before live issue creation."
      ],
      pendingQuestions: state.requests,
      nextStep: "Run the AO spawn plan for newly activated sessions."
    });
  }

  const dashboard = buildDashboardModel(state);

  console.log(
    JSON.stringify(
      {
        activatedSessions: activated.map((session) => session.id),
        scheduler: scheduler.snapshot(),
        dashboardCounts: dashboard.counts
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
