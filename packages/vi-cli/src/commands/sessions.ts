import { Command } from "commander";
import type { RemoteAgentJob } from "@vi/client-sdk";
import { getClient } from "../client.js";
import { withRelay, exit, ExitCode } from "../exit.js";
import { printTable, printJson, ago, short } from "../format.js";

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
