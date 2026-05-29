import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { Command } from "commander";
import {
  resolveSkill,
  listSkills,
  warnCredentials,
  parseSkillUrl,
  readSkillLock,
  writeSkillLock,
} from "../skill.js";
import { printTable, printJson, short } from "../format.js";
import { exit, ExitCode } from "../exit.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function assertGit(): void {
  try {
    execSync("git --version", { stdio: "pipe" });
  } catch {
    exit(ExitCode.USER_ERROR, "vi skills add requires git — install git and retry");
  }
}

async function promptYN(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // non-interactive / piped: auto-proceed
  return new Promise((resolve) => {
    process.stdout.write(`${question} [y/N] `);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data: Buffer | string) => {
      process.stdin.pause();
      resolve(String(data).trim().toLowerCase() === "y");
    });
  });
}

function cloneAndCopy(
  parsed: { repoUrl: string; subdirectory: string; branch: string },
  targetDir: string,
): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `vi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    // Shallow clone
    const branchArgs = parsed.branch !== "HEAD" ? `--branch ${parsed.branch} ` : "";
    try {
      execSync(`git clone --depth 1 ${branchArgs}"${parsed.repoUrl}" "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      exit(ExitCode.RELAY_ERROR, `git clone failed: ${msg}`);
    }

    // Resolve HEAD SHA
    const sha = execSync(`git -C "${tmpDir}" rev-parse HEAD`, { stdio: "pipe" })
      .toString()
      .trim();

    // Locate skill files in subdirectory
    const srcDir = parsed.subdirectory === "." ? tmpDir : path.join(tmpDir, parsed.subdirectory);
    const srcYaml = path.join(srcDir, "skill.yaml");
    const srcMd = path.join(srcDir, "instructions.md");

    if (!fs.existsSync(srcYaml)) {
      exit(ExitCode.NOT_FOUND, `skill.yaml not found at "${parsed.subdirectory}" in repo`);
    }
    if (!fs.existsSync(srcMd)) {
      exit(ExitCode.NOT_FOUND, `instructions.md not found at "${parsed.subdirectory}" in repo`);
    }

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(srcYaml, path.join(targetDir, "skill.yaml"));
    fs.copyFileSync(srcMd, path.join(targetDir, "instructions.md"));

    return sha;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Command registration ────────────────────────────────────────────────────

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage skill packs (~/.vi/skills/ or .vi/skills/)");

  // ── vi skills list ─────────────────────────────────────────────────────

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

  // ── vi skills show <name> ──────────────────────────────────────────────

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
          lock: skill.lock ?? null,
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
      if (skill.lock) {
        rows.push(["Origin", skill.lock.originUrl]);
        rows.push(["Pinned commit", skill.lock.pinnedCommit.slice(0, 12)]);
        rows.push(["Fetched at", skill.lock.fetchedAt]);
      }
      printTable(["Field", "Value"], rows);

      const preview = skill.instructions.trimEnd().split("\n").slice(0, 15);
      process.stdout.write("\n--- Instructions preview ---\n");
      process.stdout.write(preview.join("\n") + "\n");
      if (skill.instructions.split("\n").length > 15) {
        process.stdout.write("  ... (truncated)\n");
      }
    });

  // ── vi skills init <name> ──────────────────────────────────────────────

  skills
    .command("init <name>")
    .description("Scaffold a new skill pack with starter files")
    .option("--project", "Create under <project-root>/.vi/skills/ instead of ~/.vi/skills/")
    .option("--force", "Overwrite if skill already exists")
    .action((name: string, opts: { project?: boolean; force?: boolean }) => {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        exit(ExitCode.USER_ERROR, `invalid skill name "${name}" — use lowercase letters, numbers, hyphens, underscores`);
      }

      let skillDir: string;
      if (opts.project) {
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

  // ── vi skills add <url> ────────────────────────────────────────────────

  skills
    .command("add <url>")
    .description("Import a skill from a GitHub repo into ~/.vi/skills/")
    .option("--name <name>", "Local name for the skill (defaults to directory name in the URL)")
    .option("--force", "Overwrite if a skill with this name already exists")
    .option("--yes", "Skip confirmation prompt (useful in scripts)")
    .action(async (url: string, opts: { name?: string; force?: boolean; yes?: boolean }) => {
      assertGit();

      const parsed = parseSkillUrl(url);

      // Derive default name from the last path segment
      const defaultName = parsed.subdirectory === "."
        ? parsed.repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? "imported-skill"
        : parsed.subdirectory.split("/").pop() ?? "imported-skill";
      const skillName = opts.name ?? defaultName;

      if (!/^[a-z0-9][a-z0-9_-]*$/.test(skillName)) {
        exit(ExitCode.USER_ERROR, `invalid skill name "${skillName}" — use lowercase letters, numbers, hyphens, underscores`);
      }

      const targetDir = path.join(os.homedir(), ".vi", "skills", skillName);
      if (fs.existsSync(targetDir) && !opts.force) {
        exit(ExitCode.USER_ERROR, `skill "${skillName}" already exists at ${targetDir}\nUse --force to overwrite`);
      }

      process.stdout.write(`Fetching skill from: ${parsed.repoUrl}\n`);
      if (parsed.subdirectory !== ".") {
        process.stdout.write(`  subdirectory: ${parsed.subdirectory}\n`);
      }
      process.stdout.write(`  branch: ${parsed.branch === "HEAD" ? "default" : parsed.branch}\n`);
      process.stdout.write("\n");

      // Clone into temp, copy files
      const sha = cloneAndCopy(parsed, targetDir);

      // Preview
      process.stdout.write("--- skill.yaml ---\n");
      process.stdout.write(fs.readFileSync(path.join(targetDir, "skill.yaml"), "utf8"));
      process.stdout.write("\n--- instructions.md (first 20 lines) ---\n");
      const instructionLines = fs.readFileSync(path.join(targetDir, "instructions.md"), "utf8")
        .split("\n")
        .slice(0, 20);
      process.stdout.write(instructionLines.join("\n") + "\n");
      if (fs.readFileSync(path.join(targetDir, "instructions.md"), "utf8").split("\n").length > 20) {
        process.stdout.write("  ... (truncated)\n");
      }
      process.stdout.write("\n");

      // Confirm (skip in non-TTY or --yes)
      if (!opts.yes) {
        const ok = await promptYN(`Add skill "${skillName}" from ${sha.slice(0, 8)}?`);
        if (!ok) {
          // Remove the already-copied files
          try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
          process.stdout.write("Aborted.\n");
          process.exit(ExitCode.SUCCESS);
        }
      }

      // Write lock file
      writeSkillLock(targetDir, {
        originUrl: parsed.originUrl,
        repoUrl: parsed.repoUrl,
        subdirectory: parsed.subdirectory,
        branch: parsed.branch,
        pinnedCommit: sha,
        fetchedAt: new Date().toISOString(),
      });

      // Credential scan
      const instructions = fs.readFileSync(path.join(targetDir, "instructions.md"), "utf8");
      const warnings = warnCredentials(instructions);
      for (const w of warnings) {
        process.stderr.write(`Warning: ${w}\n`);
      }

      process.stdout.write(`Skill "${skillName}" added @ ${sha.slice(0, 12)}\n`);
      process.stdout.write(`  ${targetDir}\n`);
      process.stdout.write(`\nTo use:  vi session create --skill ${skillName} --agent <id> --goal "..."\n`);
    });

  // ── vi skills sync [name] ──────────────────────────────────────────────

  skills
    .command("sync [name]")
    .description("Re-fetch all remote skills (or a named one) from their pinned origin")
    .action(async (nameArg: string | undefined) => {
      assertGit();

      const userSkillsDir = path.join(os.homedir(), ".vi", "skills");
      const names: string[] = [];

      if (nameArg) {
        names.push(nameArg);
      } else {
        // All skills that have a lock file
        if (fs.existsSync(userSkillsDir)) {
          for (const entry of fs.readdirSync(userSkillsDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const lockPath = path.join(userSkillsDir, entry.name, ".skill-lock.json");
              if (fs.existsSync(lockPath)) names.push(entry.name);
            }
          }
        }
      }

      if (names.length === 0) {
        process.stdout.write(
          nameArg
            ? `Skill "${nameArg}" not found or has no remote origin.\n`
            : "No remote skills to sync. Use vi skills add <url> to import one.\n",
        );
        return;
      }

      for (const name of names) {
        const skillDir = path.join(userSkillsDir, name);
        const lock = readSkillLock(skillDir);
        if (!lock) {
          process.stdout.write(`${name}: no remote origin — skipping (locally created)\n`);
          continue;
        }

        process.stdout.write(`${name}: fetching from ${lock.repoUrl} ...\n`);
        const newSha = cloneAndCopy(
          { repoUrl: lock.repoUrl, subdirectory: lock.subdirectory, branch: lock.branch },
          skillDir,
        );

        if (newSha === lock.pinnedCommit) {
          process.stdout.write(`${name}: up to date (${newSha.slice(0, 12)})\n`);
        } else {
          writeSkillLock(skillDir, {
            ...lock,
            pinnedCommit: newSha,
            fetchedAt: new Date().toISOString(),
          });

          // Credential scan on updated instructions
          const instructions = fs.readFileSync(path.join(skillDir, "instructions.md"), "utf8");
          const warnings = warnCredentials(instructions);
          for (const w of warnings) {
            process.stderr.write(`Warning (${name}): ${w}\n`);
          }

          process.stdout.write(
            `${name}: updated ${lock.pinnedCommit.slice(0, 12)} → ${newSha.slice(0, 12)}\n`,
          );
        }
      }
    });

  // ── vi skills remove <name> ────────────────────────────────────────────

  skills
    .command("remove <name>")
    .description("Delete a skill pack from ~/.vi/skills/")
    .option("--force", "Skip confirmation prompt")
    .action(async (name: string, opts: { force?: boolean }) => {
      const skillDir = path.join(os.homedir(), ".vi", "skills", name);

      if (!fs.existsSync(skillDir)) {
        exit(ExitCode.NOT_FOUND, `skill not found: ${name} (checked ${skillDir})`);
      }

      if (!opts.force) {
        const ok = await promptYN(`Remove skill "${name}" at ${skillDir}?`);
        if (!ok) {
          process.stdout.write("Aborted.\n");
          process.exit(ExitCode.SUCCESS);
        }
      }

      fs.rmSync(skillDir, { recursive: true, force: true });
      process.stdout.write(`Removed skill "${name}".\n`);
    });

  // ── vi skills validate <name> ──────────────────────────────────────────

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
    });
}
