import { Command } from "commander";
import { getClient } from "../client.js";
import { withRelay } from "../exit.js";
import { printTable, printJson, ago, short } from "../format.js";

export function registerApprovalsCommand(program: Command): void {
  program
    .command("approvals")
    .description("List approval requests (default: open only)")
    .option("--status <status>", "Filter by status: open | approved | rejected | all (default: open)")
    .option("--json", "Output JSON only")
    .action(async (opts: { status?: string; json?: boolean }) => {
      const { requests } = await withRelay(() => getClient().getRemoteApprovalOverview());
      const statusFilter = opts.status ?? "open";

      const filtered =
        statusFilter === "all"
          ? requests
          : requests.filter((r) => r.status === statusFilter);

      if (opts.json) {
        printJson(filtered);
        return;
      }

      if (filtered.length === 0) {
        process.stdout.write(
          statusFilter === "open"
            ? "No open approvals.\n"
            : `No ${statusFilter} approvals.\n`,
        );
        return;
      }

      printTable(
        ["Request ID", "Machine", "Title", "Risk", "Status", "Age"],
        filtered.map((r) => [
          short(r.requestId, 20),
          short(r.agentId, 18),
          short(r.title, 32),
          r.riskLevel,
          r.status,
          ago(r.createdAt),
        ]),
      );
    });
}
