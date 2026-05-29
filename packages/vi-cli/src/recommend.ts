import type { Skill } from "./skill.js";

export interface SkillRecommendation {
  name: string;
  score: number;         // 0.0–1.0
  matchedOn: string[];   // e.g. ["name:debug", "desc:electron", "instr:polling"]
  description?: string;
  source: "project" | "user" | "remote";
}

const STOPWORDS = new Set([
  "a","an","the","is","in","for","to","of","and","or","with","on","at","by",
  "from","into","this","that","it","be","as","are","was","has","have","do",
  "did","can","will","should","would","could","not","no","its","we","i","you",
  "me","my","your","our","their","they","them","he","she","his","her","us",
  "if","so","but","yet","nor","both","either","neither","just","also","than",
  "then","when","how","what","which","where","who","why","get","use","make",
  "new","add","set","run","fix","via","per","etc","ie","eg","vs","re",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s\-_./,;:!?()\[\]{}'"`<>+=#@&*|\\^~]+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
  );
}

function anySubstring(token: string, fieldTokens: Set<string>): boolean {
  for (const ft of fieldTokens) {
    if (ft.includes(token) || token.includes(ft)) return true;
  }
  return false;
}

export function scoreSkill(taskTokens: Set<string>, skill: Skill): SkillRecommendation {
  if (taskTokens.size === 0) {
    return {
      name: skill.name,
      score: 0,
      matchedOn: [],
      description: skill.meta.description,
      source: skill.source,
    };
  }

  const nameTokens = tokenize(skill.meta.name);
  const descTokens = tokenize(skill.meta.description ?? "");
  const instrTokens = tokenize(skill.instructions.slice(0, 2048));

  let weightedHits = 0;
  const matchedOn: string[] = [];
  const matched = new Set<string>();

  for (const token of taskTokens) {
    if (matched.has(token)) continue;
    if (anySubstring(token, nameTokens)) {
      weightedHits += 3;
      matchedOn.push(`name:${token}`);
      matched.add(token);
    } else if (anySubstring(token, descTokens)) {
      weightedHits += 2;
      matchedOn.push(`desc:${token}`);
      matched.add(token);
    } else if (instrTokens.has(token)) {
      // Exact match only for instructions (substring would be too noisy)
      weightedHits += 1;
      matchedOn.push(`instr:${token}`);
      matched.add(token);
    }
  }

  const maxPossible = taskTokens.size * 3;
  const score = Math.round((weightedHits / maxPossible) * 100) / 100;

  return {
    name: skill.name,
    score,
    matchedOn,
    description: skill.meta.description,
    source: skill.source,
  };
}

export function recommendSkills(task: string, skills: Skill[], top = 5): SkillRecommendation[] {
  const taskTokens = tokenize(task);
  return skills
    .map((s) => scoreSkill(taskTokens, s))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
