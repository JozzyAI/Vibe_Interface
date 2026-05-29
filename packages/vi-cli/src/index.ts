#!/usr/bin/env node
import { Command } from "commander";
import { registerConfigCommands } from "./commands/config.js";
import { registerOverviewCommand } from "./commands/overview.js";
import { registerMachinesCommand } from "./commands/machines.js";
import { registerSessionCommands } from "./commands/sessions.js";
import { registerApprovalsCommand } from "./commands/approvals.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { exit, ExitCode } from "./exit.js";

const program = new Command();

program
  .name("vi")
  .description("VI CLI — orchestrate remote machines and sessions through VI Relay")
  .version("0.1.0")
  .addHelpText(
    "after",
    `
Config:
  vi config set --base-url <url> --token <token>
  vi config show
  Or set VI_RELAY_BASE_URL + VI_RELAY_VI_TOKEN env vars.

Exit codes:
  0  success
  1  user/config error
  2  relay/network/auth error
  3  not found
  4  read-only violation (Phase 2)`,
  );

registerConfigCommands(program);
registerOverviewCommand(program);
registerMachinesCommand(program);
registerSessionCommands(program);
registerApprovalsCommand(program);
registerSkillsCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  exit(ExitCode.USER_ERROR, err instanceof Error ? err.message : String(err));
});
