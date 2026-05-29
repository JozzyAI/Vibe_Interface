import { type NextRequest } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";

interface SkillEntry {
  name: string;
  description: string | null;
  allowedTools: string[] | null;
  instructions: string;
  source: "project" | "user";
}

// Minimal line-by-line YAML parser — handles the skill.yaml subset only.
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
    if (/^allowedTools\s*:/.test(trimmed)) { inAllowedTools = true; continue; }
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

function loadSkill(skillDir: string, name: string, source: "project" | "user"): SkillEntry | null {
  const yamlPath = path.join(skillDir, "skill.yaml");
  const instructionsPath = path.join(skillDir, "instructions.md");
  if (!fs.existsSync(yamlPath) || !fs.existsSync(instructionsPath)) return null;

  const raw = parseSkillYaml(fs.readFileSync(yamlPath, "utf8"));
  const instructions = fs.readFileSync(instructionsPath, "utf8");

  return {
    name,
    description: (raw["description"] as string) || null,
    allowedTools: (raw["allowedTools"] as string[]) || null,
    instructions,
    source,
  };
}

function findProjectSkillsDir(): string | null {
  // Walk up from CWD (process.cwd = Next.js server root, typically the repo root)
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

function listAllSkills(): SkillEntry[] {
  const results: SkillEntry[] = [];
  const seen = new Set<string>();

  const projectDir = findProjectSkillsDir();
  if (projectDir) {
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const skill = loadSkill(path.join(projectDir, entry.name), entry.name, "project");
      if (skill) results.push(skill);
    }
  }

  const userSkillsDir = path.join(os.homedir(), ".vi", "skills");
  if (fs.existsSync(userSkillsDir)) {
    for (const entry of fs.readdirSync(userSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const skill = loadSkill(path.join(userSkillsDir, entry.name), entry.name, "user");
      if (skill) results.push(skill);
    }
  }

  return results;
}

// No cache — skills are edited locally and changes should be reflected immediately.
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const skills = listAllSkills();
    return jsonWithCorrelation(skills, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load skills" },
      { status: 500 },
      correlationId,
    );
  }
}
