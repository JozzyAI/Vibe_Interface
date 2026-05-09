import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class FileContextStore {
  constructor(baseDir = path.resolve(process.cwd(), "data", "sessions")) {
    this.baseDir = baseDir;
  }

  getSessionDir(sessionId) {
    return path.join(this.baseDir, sessionId);
  }

  async ensureSessionDir(sessionId) {
    await mkdir(this.getSessionDir(sessionId), { recursive: true });
  }

  async saveSummary(sessionId, summaryMarkdown) {
    await this.ensureSessionDir(sessionId);
    await writeFile(
      path.join(this.getSessionDir(sessionId), "session-summary.md"),
      summaryMarkdown,
      "utf8"
    );
  }

  async savePendingQuestions(sessionId, pendingQuestions) {
    await this.ensureSessionDir(sessionId);
    await writeFile(
      path.join(this.getSessionDir(sessionId), "pending-questions.json"),
      JSON.stringify(pendingQuestions, null, 2),
      "utf8"
    );
  }

  async saveExecutionState(sessionId, executionState) {
    await this.ensureSessionDir(sessionId);
    await writeFile(
      path.join(this.getSessionDir(sessionId), "execution-state.json"),
      JSON.stringify(executionState, null, 2),
      "utf8"
    );
  }

  async writeHandoff(session, options = {}) {
    const summary = [
      `# ${session.title}`,
      "",
      `- Session: ${session.id}`,
      `- Repo: ${session.repo}`,
      `- State: ${session.state}`,
      `- Branch: ${session.branch ?? "not created yet"}`,
      `- PR: ${session.prUrl ?? "not opened yet"}`,
      "",
      "## Current goal",
      options.currentGoal ?? "Continue execution against the linked GitHub issue.",
      "",
      "## Completed",
      ...(options.completed ?? ["Execution summary pending."]),
      "",
      "## Current diff / tests",
      ...(options.diffAndTests ?? ["No diff or test summary recorded yet."]),
      "",
      "## Blockers",
      ...(options.blockers ?? ["No blockers recorded."]),
      "",
      "## Suggested next step",
      options.nextStep ?? "Resume AO session and continue from execution-state.json."
    ].join("\n");

    await this.saveSummary(session.id, summary);
    await this.savePendingQuestions(session.id, options.pendingQuestions ?? []);
    await this.saveExecutionState(session.id, {
      sessionId: session.id,
      issueId: session.issueId,
      updatedAt: new Date().toISOString(),
      state: session.state,
      lastUpdate: session.lastUpdate,
      aoRestoreHint: {
        command: `ao session restore ${session.id}`
      },
      nextAction: options.nextStep ?? "Resume session",
      checkpoints: options.checkpoints ?? []
    });
  }

  async loadSessionContext(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);

    const [summary, pendingQuestions, executionState] = await Promise.all([
      this.safeRead(path.join(sessionDir, "session-summary.md"), "text"),
      this.safeRead(path.join(sessionDir, "pending-questions.json"), "json"),
      this.safeRead(path.join(sessionDir, "execution-state.json"), "json")
    ]);

    return {
      sessionId,
      summary,
      pendingQuestions: pendingQuestions ?? [],
      executionState: executionState ?? null
    };
  }

  async safeRead(filePath, mode) {
    try {
      const value = await readFile(filePath, "utf8");
      return mode === "json" ? JSON.parse(value) : value;
    } catch {
      return null;
    }
  }
}
