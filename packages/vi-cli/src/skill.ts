import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface SkillMeta {
  name: string;
  description?: string;
  allowedTools?: string[];
  version?: string;
}

export interface Skill {
  name: string;
  meta: SkillMeta;
  instructions: string;
  sourcePath: string;
  source: "project" | "user";
}

// Minimal line-by-line YAML parser — handles key: value pairs and list values under allowedTools.
// No external YAML dep needed for this schema.
function parseSkillYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let inAllowedTools = false;
  const tools: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      if (trimmed === "") inAllowedTools = false;
      continue;
    }
    if (/^allowedTools\s*:/.test(trimmed)) {
      inAllowedTools = true;
      continue;
    }
    if (inAllowedTools && /^-\s+/.test(trimmed)) {
      tools.push(trimmed.replace(/^-\s+/, "").replace(/^["']|["']$/g, ""));
      continue;
    }
    inAllowedTools = false;
    const m = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }

  if (tools.length > 0) result["allowedTools"] = tools;
  return result;
}

function findProjectSkillsDir(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".vi", "skills");
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function userSkillsDir(): string {
  return path.join(os.homedir(), ".vi", "skills");
}

function loadSkillFromDir(skillDir: string, name: string, source: "project" | "user"): Skill | null {
  const yamlPath = path.join(skillDir, "skill.yaml");
  const instructionsPath = path.join(skillDir, "instructions.md");
  if (!fs.existsSync(yamlPath) || !fs.existsSync(instructionsPath)) return null;

  const raw = parseSkillYaml(fs.readFileSync(yamlPath, "utf8"));
  const instructions = fs.readFileSync(instructionsPath, "utf8");

  return {
    name,
    meta: {
      name: (raw["name"] as string) || name,
      description: raw["description"] as string | undefined,
      allowedTools: raw["allowedTools"] as string[] | undefined,
      version: raw["version"] as string | undefined,
    },
    instructions,
    sourcePath: skillDir,
    source,
  };
}

// Resolution order: project .vi/skills > ~/.vi/skills > built-in (none in Phase 1)
export function resolveSkill(skillName: string): Skill | null {
  const projectDir = findProjectSkillsDir();
  if (projectDir) {
    const candidate = path.join(projectDir, skillName);
    if (fs.existsSync(candidate)) {
      const skill = loadSkillFromDir(candidate, skillName, "project");
      if (skill) return skill;
    }
  }

  const userDir = path.join(userSkillsDir(), skillName);
  if (fs.existsSync(userDir)) {
    return loadSkillFromDir(userDir, skillName, "user");
  }

  return null;
}

export function listSkills(): Array<{ name: string; source: "project" | "user"; description?: string }> {
  const results: Array<{ name: string; source: "project" | "user"; description?: string }> = [];
  const seen = new Set<string>();

  const projectDir = findProjectSkillsDir();
  if (projectDir && fs.existsSync(projectDir)) {
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const skill = loadSkillFromDir(path.join(projectDir, entry.name), entry.name, "project");
      results.push({ name: entry.name, source: "project", description: skill?.meta.description });
    }
  }

  const uDir = userSkillsDir();
  if (fs.existsSync(uDir)) {
    for (const entry of fs.readdirSync(uDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const skill = loadSkillFromDir(path.join(uDir, entry.name), entry.name, "user");
      results.push({ name: entry.name, source: "user", description: skill?.meta.description });
    }
  }

  return results;
}

// Compose VI_INITIAL_GOAL from skill + optional user goal.
// Header makes it clear to vi-agent that a skill pack was injected.
export function composeGoal(skill: Skill, userGoal?: string): string {
  const header = `[SKILL: ${skill.meta.name}]`;
  const instructions = skill.instructions.trimEnd();

  if (!userGoal?.trim()) {
    return `${header}\n${instructions}`;
  }

  return `${header}\n${instructions}\n\n--- Goal ---\n${userGoal.trim()}`;
}

// Patterns for credential-like strings — conservative (specific prefixes only).
// Phase 1: warn only, never hard-fail. A match in docs/examples is fine.
const CRED_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "GitHub PAT (ghp_...)", pattern: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token (github_pat_...)", pattern: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/ },
  { name: "AWS access key ID (AKIA...)", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "OpenAI key (sk-...)", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "PEM private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

export function warnCredentials(text: string): string[] {
  const warnings: string[] = [];
  for (const { name, pattern } of CRED_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push(`possible ${name} found — verify this is not a real credential`);
    }
  }
  return warnings;
}
