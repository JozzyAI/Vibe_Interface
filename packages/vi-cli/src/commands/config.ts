import { Command } from "commander";
import { configSet, configShow, configClear } from "../config.js";
import { exit, ExitCode } from "../exit.js";

export function registerConfigCommands(program: Command): void {
  const cfg = program
    .command("config")
    .description("Manage local VI CLI configuration (~/.vi/config.json)");

  cfg
    .command("set")
    .description("Set relay base URL and/or token")
    .option("--base-url <url>", "Relay HTTP base URL")
    .option("--token <token>", "VI relay token (stored in config, never printed)")
    .action((opts: { baseUrl?: string; token?: string }) => {
      if (!opts.baseUrl && !opts.token) {
        exit(ExitCode.USER_ERROR, "specify at least --base-url or --token");
      }
      configSet(opts);
    });

  cfg
    .command("show")
    .description("Show current configuration (token is always redacted)")
    .action(() => configShow());

  cfg
    .command("clear")
    .description("Delete ~/.vi/config.json")
    .action(() => configClear());
}
