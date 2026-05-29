import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { tokenize } from "./recommend.js";

export interface RemoteSkillCandidate {
  name: string;
  description: string;
  sourceRepo: string;
  addUrl: string;
  riskNotes: string[];
}

export interface SkillIndex {
  refreshedAt: string;
  ttlSeconds: number;
  skills: RemoteSkillCandidate[];
}

export interface RemoteSkillScore extends RemoteSkillCandidate {
  score: number;
  matchedOn: string[];
}

const INDEX_PATH = path.join(os.homedir(), ".vi", "skill-index.json");
const INDEX_TTL_SECONDS = 86_400; // 24 hours

const CURATED_SOURCES: Array<{ repo: string; branch: string; format: "standard" | "skill-md" }> = [
  { repo: "anthropics/skills",                            branch: "main", format: "standard" },
  { repo: "addyosmani/agent-skills",                      branch: "main", format: "standard" },
  { repo: "addyosmani/web-quality-skills",                branch: "main", format: "standard" },
  { repo: "alirezarezvani/claude-skills",                 branch: "main", format: "standard" },
  { repo: "ComposioHQ/awesome-claude-skills",             branch: "main", format: "skill-md" },
  { repo: "hashicorp/agent-skills",                       branch: "main", format: "standard" },
  { repo: "supabase/agent-skills",                        branch: "main", format: "standard" },
  { repo: "shakacode/claude-code-commands-skills-agents", branch: "main", format: "standard" },
  // VoltAgent/awesome-agent-skills = awesome-list (links only) — not a direct skill repo
];

const SKIP_DIRS = new Set([".github", "node_modules", "dist", "src", "docs", "doc", "test", "tests", ".git", "__pycache__"]);
const SCRIPT_EXTS = new Set([".sh", ".py", ".js", ".ts", ".rb", ".pl", ".bash"]);

async function githubGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "vi-cli/0.1.0",
      "Accept": "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const msg = reset
      ? `GitHub API rate limited — resets at ${new Date(Number(reset) * 1000).toISOString()}`
      : "GitHub API rate limited";
    throw new Error(msg);
  }
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${url}`);
  }
  return res.json() as Promise<T>;
}

function parseSkillMdFrontmatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

async function fetchSourceSkills(source: typeof CURATED_SOURCES[0]): Promise<RemoteSkillCandidate[]> {
  type GHEntry = { name: string; type: string; path: string };
  type GHRepoMeta = { pushed_at?: string };
  type GHFileEntry = GHEntry & { size: number };

  // Get repo metadata for staleness detection
  let isStale = false;
  try {
    const meta = await githubGet<GHRepoMeta>(`https://api.github.com/repos/${source.repo}`);
    if (meta.pushed_at) {
      const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      isStale = meta.pushed_at < oneYearAgo;
    }
  } catch { /* non-fatal — skip staleness check */ }

  const contents = await githubGet<GHEntry[]>(
    `https://api.github.com/repos/${source.repo}/contents`,
  );

  const candidates: RemoteSkillCandidate[] = [];

  for (const entry of contents) {
    if (entry.type !== "dir" || SKIP_DIRS.has(entry.name)) continue;

    const riskNotes: string[] = [];
    if (isStale) riskNotes.push("repo last updated > 1 year ago");

    let description = "";
    let skillName = entry.name;

    try {
      const dirContents = await githubGet<GHFileEntry[]>(
        `https://api.github.com/repos/${source.repo}/contents/${entry.path}`,
      );

      // Risk: script files present
      const hasScripts = dirContents.some(
        (f) => f.type === "file" && SCRIPT_EXTS.has(path.extname(f.name).toLowerCase()),
      );
      if (hasScripts) riskNotes.push("contains script files beyond skill.yaml/instructions.md");

      // Risk: unusually large instructions
      const instrFile = dirContents.find((f) => f.name === "instructions.md");
      if (instrFile && instrFile.size > 50_000) riskNotes.push("unusually large instructions (>50 KB)");

      // Description from metadata file
      const rawBase = `https://raw.githubusercontent.com/${source.repo}/${source.branch}/${entry.path}`;

      if (source.format === "standard") {
        const hasYaml = dirContents.some((f) => f.name === "skill.yaml");
        if (hasYaml) {
          try {
            const yaml = await (await fetch(`${rawBase}/skill.yaml`)).text();
            const nameM = yaml.match(/^name\s*:\s*(.+)$/m);
            const descM = yaml.match(/^description\s*:\s*(.+)$/m);
            if (nameM) skillName = nameM[1].replace(/^["']|["']$/g, "").trim();
            if (descM) description = descM[1].replace(/^["']|["']$/g, "").trim();
          } catch { /* ignore */ }
        }
      } else if (source.format === "skill-md") {
        const hasSkillMd = dirContents.some((f) => f.name === "SKILL.md");
        if (hasSkillMd) {
          try {
            const md = await (await fetch(`${rawBase}/SKILL.md`)).text();
            const fm = parseSkillMdFrontmatter(md);
            if (fm.name) skillName = fm.name;
            if (fm.description) description = fm.description;
          } catch { /* ignore */ }
        }
      }
    } catch { continue; /* if directory listing fails, skip */ }

    candidates.push({
      name: skillName || entry.name,
      description,
      sourceRepo: source.repo,
      addUrl: `https://github.com/${source.repo}/tree/${source.branch}/${entry.path}`,
      riskNotes,
    });
  }

  return candidates;
}

export async function refreshSkillIndex(
  onProgress?: (msg: string) => void,
): Promise<SkillIndex> {
  const allSkills: RemoteSkillCandidate[] = [];

  for (const source of CURATED_SOURCES) {
    onProgress?.(`Fetching ${source.repo}...`);
    try {
      const skills = await fetchSourceSkills(source);
      allSkills.push(...skills);
      onProgress?.(`  ${skills.length} skill(s) indexed`);
    } catch (err) {
      onProgress?.(`  Warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const index: SkillIndex = {
    refreshedAt: new Date().toISOString(),
    ttlSeconds: INDEX_TTL_SECONDS,
    skills: allSkills,
  };

  fs.mkdirSync(path.join(os.homedir(), ".vi"), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
  return index;
}

export function loadSkillIndex(): { index: SkillIndex | null; staleSeconds: number | null } {
  if (!fs.existsSync(INDEX_PATH)) return { index: null, staleSeconds: null };
  try {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as SkillIndex;
    const ageSeconds = (Date.now() - new Date(index.refreshedAt).getTime()) / 1000;
    const ttl = index.ttlSeconds ?? INDEX_TTL_SECONDS;
    const staleSeconds = ageSeconds > ttl ? Math.round(ageSeconds - ttl) : null;
    return { index, staleSeconds };
  } catch {
    return { index: null, staleSeconds: null };
  }
}

export function clearSkillIndex(): boolean {
  if (!fs.existsSync(INDEX_PATH)) return false;
  fs.unlinkSync(INDEX_PATH);
  return true;
}

export function searchSkillIndex(
  query: string,
  skills: RemoteSkillCandidate[],
  top = 10,
): RemoteSkillScore[] {
  const queryTokens = tokenize(query);

  if (queryTokens.size === 0) {
    return skills.slice(0, top).map((s) => ({ ...s, score: 0, matchedOn: [] }));
  }

  return skills
    .map((s): RemoteSkillScore => {
      const nameTokens = tokenize(s.name);
      const descTokens = tokenize(s.description);

      let weightedHits = 0;
      const matchedOn: string[] = [];
      const matched = new Set<string>();

      for (const token of queryTokens) {
        if (matched.has(token)) continue;
        const inName = [...nameTokens].some((t) => t.includes(token) || token.includes(t));
        const inDesc = [...descTokens].some((t) => t.includes(token) || token.includes(t));
        if (inName) {
          weightedHits += 3;
          matchedOn.push(`name:${token}`);
          matched.add(token);
        } else if (inDesc) {
          weightedHits += 2;
          matchedOn.push(`desc:${token}`);
          matched.add(token);
        }
      }

      const maxPossible = queryTokens.size * 3;
      const score = Math.round((weightedHits / maxPossible) * 100) / 100;
      return { ...s, score, matchedOn };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

export const INDEX_FILE_PATH = INDEX_PATH;
export const CURATED_SOURCE_COUNT = CURATED_SOURCES.length;
