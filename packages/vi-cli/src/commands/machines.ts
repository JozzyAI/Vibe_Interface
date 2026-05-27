import { Command } from "commander";
import { getClient } from "../client.js";
import { withRelay } from "../exit.js";
import { printTable, printJson, ago, short } from "../format.js";

export function registerMachinesCommand(program: Command): void {
  program
    .command("machines")
    .description("List connected machines (vi-agents)")
    .option("--status <status>", "Filter by agent status (running, failed, awaiting_approval, …)")
    .option("--json", "Output JSON only")
    .action(async (opts: { status?: string; json?: boolean }) => {
      const { agents } = await withRelay(() => getClient().getRemoteApprovalOverview());

      const filtered = opts.status
        ? agents.filter((a) => a.status === opts.status)
        : agents;

      if (opts.json) {
        printJson(filtered);
        return;
      }

      if (filtered.length === 0) {
        process.stdout.write("No machines found.\n");
        return;
      }

      printTable(
        ["Agent ID", "Name", "Status", "Connection", "Approvals", "Last seen"],
        filtered.map((a) => [
          short(a.agentId, 20),
          short(a.displayName, 24),
          a.status,
          a.connectionState,
          String(a.pendingApprovalCount),
          ago(a.lastSeenAt),
        ]),
      );
    });
}
