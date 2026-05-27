import { Command } from "commander";
import { getClient } from "../client.js";
import { withRelay } from "../exit.js";
import { printTable, printJson, ago } from "../format.js";

export function registerOverviewCommand(program: Command): void {
  program
    .command("overview")
    .description("Show relay stats: machines, sessions, pending approvals")
    .option("--json", "Output JSON only")
    .action(async (opts: { json?: boolean }) => {
      const data = await withRelay(() => getClient().getRemoteApprovalOverview());

      if (opts.json) {
        printJson({ generatedAt: data.generatedAt, stats: data.stats });
        return;
      }

      printTable(
        ["Stat", "Value"],
        [
          ["Machines", String(data.stats.agents)],
          ["Running", String(data.stats.running)],
          ["Pending approvals", String(data.stats.pending)],
          ["Failed", String(data.stats.failed)],
          ["Generated", ago(data.generatedAt)],
        ],
      );
    });
}
