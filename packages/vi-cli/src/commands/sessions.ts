import { Command } from "commander";
import type { RemoteAgentJob } from "@vi/client-sdk";
import { getClient } from "../client.js";
import { withRelay, exit, guardReadOnly, ExitCode } from "../exit.js";
import { printTable, printJson, ago, short } from "../format.js";
import { resolveSkill, composeGoal } from "../skill.js";

export function registerSessionCommands(program: Command): void {
  // vi sessions
  program
    .command("sessions")
    .description("List sessions (jobs)")
    .option("--agent <agentId>", "Filter by machine/agent ID")
    .option("--status <status>", "Filter by job status (running, completed, failed, …)")
    .option("--json", "Output JSON only")
    .action(async (opts: { agent?: string; status?: string; json?: boolean }) => {
      const { jobs } = await withRelay(() => getClient().getRemoteApprovalOverview());

      let filtered = jobs;
      if (opts.agent) filtered = filtered.filter((j) => j.agentId === opts.agent);
      if (opts.status) filtered = filtered.filter((j) => j.status === opts.status);

      if (opts.json) {
        printJson(filtered);
        return;
      }

      if (filtered.length === 0) {
        process.stdout.write("No sessions found.\n");
        return;
      }

      printTable(
        ["Job ID", "Machine", "Title", "Status", "Provider state", "Age"],
        filtered.map((j) => [
          short(j.jobId, 22),
          short(j.agentId, 18),
          short(j.title ?? "(untitled)", 28),
          j.status,
          j.providerState?.state ?? "-",
          ago(j.createdAt),
        ]),
      );
    });

  // vi session <subcommand>
  const session = program
    .command("session")
    .description("Session subcommands (get, logs)");

  // vi session create
  session
    .command("create")
    .description("Start an interactive Claude session on a remote agent")
    .requiredOption("--agent <agentId>", "Agent (machine) ID to run the session on")
    .option("--cwd <path>", "Working directory on the remote machine")
    .option("--goal <text>", "Initial prompt — injected as /goal after startup, not a positional arg")
    .option("--model <model>", "Claude model override (e.g. claude-opus-4-7)")
    .option("--title <title>", "Session title shown in the dashboard")
    .option("--skill <name>", "Inject a skill pack as initial prompt context (see: vi skills list)")
    .option("--json", "Output the created job as JSON")
    .action(
      async (opts: {
        agent: string;
        cwd?: string;
        goal?: string;
        model?: string;
        title?: string;
        skill?: string;
        json?: boolean;
      }) => {
        guardReadOnly();

        // Validate agent exists
        const { agents } = await withRelay(() => getClient().getRemoteApprovalOverview());
        const agentExists = agents.some((a) => a.agentId === opts.agent);
        if (!agentExists) {
          exit(ExitCode.NOT_FOUND, `agent not found: ${opts.agent}`);
        }

        // Mirror web dashboard buildProviderCommand() for Claude
        const command: string[] = ["vi-agent", "claude"];
        if (opts.cwd?.trim()) command.push("--cwd", opts.cwd.trim());
        if (opts.model?.trim()) command.push("--", "--model", opts.model.trim());

        const title = opts.title?.trim() || "Start Claude Code via bridge";

        // Compose VI_INITIAL_GOAL: inject skill pack when --skill is given,
        // otherwise pass goal as-is (no-skill path is byte-for-byte identical).
        let initialGoal: string | undefined = opts.goal?.trim();
        if (opts.skill) {
          const skill = resolveSkill(opts.skill);
          if (!skill) {
            exit(ExitCode.NOT_FOUND, `skill not found: ${opts.skill}`);
          }
          initialGoal = composeGoal(skill, opts.goal);
        }

        // Goal goes in env — never as a positional arg (that triggers one-shot exit)
        const env: Record<string, string> = { VI_SESSION_TITLE: title };
        if (initialGoal) env["VI_INITIAL_GOAL"] = initialGoal;

        const job = await withRelay(() =>
          getClient().createRemoteAgentJob({
            agentId: opts.agent,
            title,
            command,
            cwd: opts.cwd?.trim(),
            env,
            model: opts.model?.trim() ?? null,
          }),
        );

        if (opts.json) {
          printJson(job);
          return;
        }

        process.stdout.write(`Session created: ${job.jobId}\n`);
        process.stdout.write(`Agent  : ${short(job.agentId, 22)}\n`);
        if (job.cwd) process.stdout.write(`CWD    : ${job.cwd}\n`);
        process.stdout.write(`Status : ${job.status}\n`);
      },
    );

  // vi session send <jobId> [text]
  session
    .command("send <jobId> [text]")
    .description("Send text input (or a key) to a running session")
    .option("--key <key>", "Send a special key instead of text (supported: escape)")
    .option("--no-submit", "Do not press Enter after text (ignored when --key is used)")
    .option("--json", "Output the updated job as JSON")
    .action(async (jobId: string, text: string | undefined, opts: { key?: string; submit: boolean; json?: boolean }) => {
      guardReadOnly();

      if (!opts.key && !text) {
        exit(ExitCode.USER_ERROR, "provide <text> or --key <key>");
      }
      if (opts.key && opts.key !== "escape") {
        exit(ExitCode.USER_ERROR, `unsupported key: "${opts.key}". Supported: escape`);
      }

      const { jobs } = await withRelay(() => getClient().getRemoteApprovalOverview());
      const job = jobs.find((j) => j.jobId === jobId);

      if (!job) {
        exit(ExitCode.NOT_FOUND, `session not found: ${jobId}`);
      }

      if (job.status === "completed" || job.status === "failed") {
        process.stderr.write(
          `Warning: session ${short(jobId, 22)} has status "${job.status}" — input may not be delivered.\n`,
        );
      }

      const payload: { text: string; submit?: boolean; key?: "escape" } =
        opts.key === "escape"
          ? { text: "", key: "escape" }
          : { text: text!, submit: opts.submit };

      const updated = await withRelay(() => getClient().sendJobInput(jobId, payload));

      if (opts.json) {
        printJson(updated);
        return;
      }

      process.stdout.write(`Input queued for session ${short(jobId, 22)}.\n`);
    });

  // vi session wait <jobId>
  session
    .command("wait <jobId>")
    .description("Wait until a session reaches one of the target states")
    .requiredOption(
      "--until <states>",
      "Comma-separated target states.\n" +
        "  job.status:          running, completed, failed, archived\n" +
        "  providerState.state: waiting_input, busy, waiting_approval",
    )
    .option("--timeout <seconds>", "Timeout in seconds before exit 1 (default: 300)", "300")
    .option("--json", "Output JSON only on success")
    .action(async (jobId: string, opts: { until: string; timeout: string; json?: boolean }) => {
      const targetStates = opts.until
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (targetStates.length === 0) {
        exit(ExitCode.USER_ERROR, "--until requires at least one state");
      }

      const timeoutSecs = Number.parseInt(opts.timeout, 10);
      if (!Number.isInteger(timeoutSecs) || timeoutSecs <= 0) {
        exit(ExitCode.USER_ERROR, "--timeout must be a positive integer");
      }

      const startMs = Date.now();
      const timeoutMs = timeoutSecs * 1000;

      for (;;) {
        const elapsed = Date.now() - startMs;
        if (elapsed >= timeoutMs) {
          exit(
            ExitCode.USER_ERROR,
            `timeout after ${timeoutSecs}s waiting for session ${jobId} to reach: ${targetStates.join(", ")}`,
          );
        }

        const { jobs } = await withRelay(() => getClient().getRemoteApprovalOverview());
        const job = jobs.find((j) => j.jobId === jobId);

        if (!job) {
          exit(ExitCode.NOT_FOUND, `session not found: ${jobId}`);
        }

        // Check job.status first, then job.providerState.state
        const statusMatch = targetStates.includes(job.status) ? job.status : undefined;
        const providerMatch =
          !statusMatch && job.providerState?.state && targetStates.includes(job.providerState.state)
            ? job.providerState.state
            : undefined;
        const matchedState = statusMatch ?? providerMatch;
        const matchedField = statusMatch ? "status" : providerMatch ? "providerState.state" : undefined;

        if (matchedState && matchedField) {
          const elapsedSeconds = Math.round((Date.now() - startMs) / 1000);
          if (opts.json) {
            printJson({ jobId, matchedState, matchedField, elapsedSeconds, job });
          } else {
            process.stdout.write(
              `Session ${short(jobId, 22)} reached ${matchedState} (${matchedField}) after ${elapsedSeconds}s.\n`,
            );
          }
          process.exit(ExitCode.SUCCESS);
        }

        // Sleep up to 5s, but no longer than the remaining timeout (clamp to ≥0)
        const remaining = Math.max(0, timeoutMs - (Date.now() - startMs));
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(5000, remaining)));
      }
    });

  // vi session get <jobId>
  session
    .command("get <jobId>")
    .description("Show full detail of a session")
    .option("--json", "Output JSON only")
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const { jobs } = await withRelay(() => getClient().getRemoteApprovalOverview());
      const job = jobs.find((j) => j.jobId === jobId);

      if (!job) {
        exit(ExitCode.NOT_FOUND, `session not found: ${jobId}`);
      }

      if (opts.json) {
        printJson(job);
        return;
      }

      printJobDetail(job);
    });

  // vi session logs <jobId>
  session
    .command("logs <jobId>")
    .description("Print raw log tail for a session (pipe-friendly)")
    .action(async (jobId: string) => {
      const { jobs } = await withRelay(() => getClient().getRemoteApprovalOverview());
      const job = jobs.find((j) => j.jobId === jobId);

      if (!job) {
        exit(ExitCode.NOT_FOUND, `session not found: ${jobId}`);
      }

      if (!job.logTail) {
        process.stdout.write("(no log tail available)\n");
        return;
      }

      process.stdout.write(job.logTail);
      if (!job.logTail.endsWith("\n")) process.stdout.write("\n");
    });
}

function printJobDetail(job: RemoteAgentJob): void {
  const rows: [string, string][] = [
    ["Job ID", job.jobId],
    ["Agent ID", job.agentId],
    ["Title", job.title ?? "(untitled)"],
    ["Status", job.status],
    ["Provider state", job.providerState?.state ?? "-"],
    ["Model", job.model ?? "-"],
    ["CWD", job.cwd ?? "-"],
    ["Created", job.createdAt],
    ["Updated", job.updatedAt],
  ];
  if (job.completedAt) rows.push(["Completed", job.completedAt]);
  if (job.error) rows.push(["Error", job.error]);

  printTable(["Field", "Value"], rows);

  if (job.logTail) {
    process.stdout.write("\n--- Log tail ---\n");
    process.stdout.write(job.logTail);
    if (!job.logTail.endsWith("\n")) process.stdout.write("\n");
  }
}
