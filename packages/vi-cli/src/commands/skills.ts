import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

  // vi skills init <name>
  skills
    .command("init <name>")
    .description("Scaffold a new skill pack with starter files")
    .option("--project", "Create under <project-root>/.vi/skills/ instead of ~/.vi/skills/")
    .option("--force", "Overwrite if skill already exists")
    .action((name: string, opts: { project?: boolean; force?: boolean }) => {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        exit(ExitCode.USER_ERROR, `invalid skill name "${name}" — use lowercase letters, numbers, hyphens, underscores`);
      }

      // Determine target directory
      let skillDir: string;
      if (opts.project) {
        // Walk up to git root or CWD
        let dir = process.cwd();
        while (true) {
          if (fs.existsSync(path.join(dir, ".git"))) break;
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        skillDir = path.join(dir, ".vi", "skills", name);
      } else {
        skillDir = path.join(os.homedir(), ".vi", "skills", name);
      }

      if (fs.existsSync(skillDir) && !opts.force) {
        exit(ExitCode.USER_ERROR, `skill "${name}" already exists at ${skillDir}\nUse --force to overwrite`);
      }

      fs.mkdirSync(skillDir, { recursive: true });

      fs.writeFileSync(
        path.join(skillDir, "skill.yaml"),
        [
          `name: ${name}`,
          `description: A short description of what this skill does`,
          `version: "1.0"`,
          `# allowedTools is display-only — shown in "vi skills show", never enforced`,
          `# allowedTools:`,
          `#   - Read`,
          `#   - Bash`,
          "",
        ].join("\n"),
      );

      fs.writeFileSync(
        path.join(skillDir, "instructions.md"),
        [
          `# ${name}`,
          "",
          `<!-- One-line description of what this skill does. -->`,
          "",
          `## Role`,
          "",
          `You are assisting with <!-- describe the task context -->.`,
          "",
          `## Instructions`,
          "",
          `<!-- Step-by-step instructions. Be specific — the agent receives this`,
          `     as its first prompt, before your --goal text. -->`,
          "",
          `1. `,
          "",
          `## Output format`,
          "",
          `<!-- Describe expected output format, length, or structure. -->`,
          "",
        ].join("\n"),
      );

      const source = opts.project ? "project" : "user";
      process.stdout.write(`Skill "${name}" created (${source}):\n`);
      process.stdout.write(`  ${path.join(skillDir, "skill.yaml")}\n`);
      process.stdout.write(`  ${path.join(skillDir, "instructions.md")}\n`);
      process.stdout.write(`\nNext steps:\n`);
      process.stdout.write(`  1. Edit ${path.join(skillDir, "instructions.md")}\n`);
      process.stdout.write(`  2. vi skills validate ${name}\n`);
      process.stdout.write(`  3. vi session create --skill ${name} --agent <agentId> --goal "..."\n`);
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
