import { Command } from "commander";
import { getClient } from "../client.js";
import { withRelay, exit, guardReadOnly, ExitCode } from "../exit.js";
import { printTable, printJson, ago, short } from "../format.js";

export function registerApprovalsCommand(program: Command): void {
  // vi approvals
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

  // vi approve <requestId>
  program
    .command("approve <requestId>")
    .description("Approve an open approval request")
    .option("--response <text>", "Optional approval note")
    .option("--json", "Output the updated approval request as JSON")
    .action(async (requestId: string, opts: { response?: string; json?: boolean }) => {
      guardReadOnly();
      await respondToApproval(requestId, "approve", opts.response, opts.json);
    });

  // vi reject <requestId>
  program
    .command("reject <requestId>")
    .description("Reject an open approval request")
    .option("--response <text>", "Optional rejection reason")
    .option("--json", "Output the updated approval request as JSON")
    .action(async (requestId: string, opts: { response?: string; json?: boolean }) => {
      guardReadOnly();
      await respondToApproval(requestId, "reject", opts.response, opts.json);
    });
}

async function respondToApproval(
  requestId: string,
  action: "approve" | "reject",
  response: string | undefined,
  json: boolean | undefined,
): Promise<void> {
  const { requests } = await withRelay(() => getClient().getRemoteApprovalOverview());
  const req = requests.find((r) => r.requestId === requestId);

  if (!req) {
    exit(ExitCode.NOT_FOUND, `approval request not found: ${requestId}`);
  }

  if (req.status !== "open") {
    exit(ExitCode.USER_ERROR, `approval request is already "${req.status}": ${requestId}`);
  }

  const updated = await withRelay(() =>
    getClient().respondToRemoteApproval({ requestId, action, response }),
  );

  if (json) {
    printJson(updated);
    return;
  }

  const label = action === "approve" ? "Approved" : "Rejected";
  process.stdout.write(`${label}: ${requestId}\n`);
}
