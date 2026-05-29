import { Command } from "commander";
import { resolveSkill, listSkills, warnCredentials } from "../skill.js";
import { printTable, printJson, short } from "../format.js";
import { exit, ExitCode } from "../exit.js";

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage skill packs (~/.vi/skills/ or .vi/skills/)");

  // vi skills list
  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output JSON only")
    .action((opts: { json?: boolean }) => {
      const all = listSkills();

      if (opts.json) {
        printJson(all);
        return;
      }

      if (all.length === 0) {
        process.stdout.write(
          "No skills found.\n" +
          "Create one at ~/.vi/skills/<name>/ with skill.yaml + instructions.md\n",
        );
        return;
      }

      printTable(
        ["Name", "Source", "Description"],
        all.map((s) => [s.name, s.source, short(s.description ?? "(no description)", 60)]),
      );
    });

  // vi skills show <name>
  skills
    .command("show <name>")
    .description("Show full detail of a skill pack")
    .option("--json", "Output JSON only")
    .action((name: string, opts: { json?: boolean }) => {
      const skill = resolveSkill(name);
      if (!skill) {
        exit(ExitCode.NOT_FOUND, `skill not found: ${name}`);
      }

      if (opts.json) {
        printJson({
          name: skill.name,
          source: skill.source,
          sourcePath: skill.sourcePath,
          meta: skill.meta,
          instructions: skill.instructions,
        });
        return;
      }

      const toolsDisplay = skill.meta.allowedTools?.join(", ") ?? "(not specified)";
      const rows: [string, string][] = [
        ["Name", skill.meta.name],
        ["Description", skill.meta.description ?? "(not set)"],
        ["Version", skill.meta.version ?? "(not set)"],
        ["Source", skill.source],
        ["Path", skill.sourcePath],
        ["Allowed tools", `${toolsDisplay}  [display only — not enforced]`],
      ];
      printTable(["Field", "Value"], rows);

      const preview = skill.instructions.trimEnd().split("\n").slice(0, 15);
      process.stdout.write("\n--- Instructions preview ---\n");
      process.stdout.write(preview.join("\n") + "\n");
      if (skill.instructions.split("\n").length > 15) {
        process.stdout.write("  ... (truncated)\n");
      }
    });

  // vi skills validate <name>
  skills
    .command("validate <name>")
    .description("Validate a skill pack (warns on issues, always exits 0)")
    .action((name: string) => {
      const skill = resolveSkill(name);
      if (!skill) {
        exit(ExitCode.NOT_FOUND, `skill not found: ${name}`);
      }

      const issues: string[] = [];

      if (!skill.meta.name) issues.push("skill.yaml missing 'name' field");
      if (!skill.meta.description) issues.push("skill.yaml missing 'description' (recommended)");
      if (!skill.instructions.trim()) issues.push("instructions.md is empty");

      // Credential scan — warn only, never fail
      const credWarnings = warnCredentials(skill.instructions);
      for (const w of credWarnings) {
        issues.push(`[credential warning] ${w}`);
      }

      if (issues.length === 0) {
        process.stdout.write(`Skill "${name}" is valid.\n`);
        return;
      }

      process.stdout.write(`Skill "${name}" — ${issues.length} warning(s):\n`);
      for (const issue of issues) {
        process.stdout.write(`  ⚠  ${issue}\n`);
      }
      // Always exit 0 — warnings are informational
    });
}
