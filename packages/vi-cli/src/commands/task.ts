import { Command } from "commander";
import { loadAllSkills } from "../skill.js";
import { recommendSkills, tokenize } from "../recommend.js";

interface SubtaskPlan {
  title: string;
  keywords: string[];
  recommendedSkills: Array<{ name: string; score: number; matchedOn: string[]; description?: string }>;
}

interface TaskPlan {
  goal: string;
  generatedAt: string;
  subtasks: SubtaskPlan[];
}

function extractSubtasks(goal: string): string[] {
  // Split on common connectors and newlines; keep fragments ≥ 15 chars
  const fragments = goal
    .replace(/\.\s+([A-Z])/g, "\n$1")       // ". Capital" → newline
    .split(/\s+and\s+|\s+then\s+|;\s*|\n+/)  // "and", "then", ";", newlines
    .map((f) => f.trim())
    .filter((f) => f.length >= 15);

  return fragments.length > 0 ? fragments : [goal.trim()];
}

function toSimpleYaml(obj: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]\n";
    return obj.map((item) => {
      if (typeof item === "object" && item !== null) {
        const inner = toSimpleYaml(item, indent + 2);
        return `${pad}- ${inner.trimStart()}`;
      }
      return `${pad}- ${JSON.stringify(item)}\n`;
    }).join("");
  }
  if (typeof obj === "object" && obj !== null) {
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []\n`;
          return `${pad}${k}:\n${toSimpleYaml(v, indent + 2)}`;
        }
        if (typeof v === "object" && v !== null) {
          return `${pad}${k}:\n${toSimpleYaml(v, indent + 2)}`;
        }
        return `${pad}${k}: ${JSON.stringify(v)}\n`;
      })
      .join("");
  }
  return `${JSON.stringify(obj)}\n`;
}

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Task planning and skill decomposition");

  task
    .command("plan")
    .description("Decompose a goal into subtasks and recommend installed skills for each")
    .requiredOption("--goal <text>", "High-level goal to decompose")
    .option("--json", "Output JSON")
    .option("--yaml", "Output YAML")
    .action((opts: { goal: string; json?: boolean; yaml?: boolean }) => {
      const skills = loadAllSkills();
      const subtasks = extractSubtasks(opts.goal);

      const plan: TaskPlan = {
        goal: opts.goal,
        generatedAt: new Date().toISOString(),
        subtasks: subtasks.map((title) => {
          const recs = recommendSkills(title, skills, 3);
          const keywords = [...tokenize(title)].slice(0, 8);
          return {
            title,
            keywords,
            recommendedSkills: recs.map((r) => ({
              name: r.name,
              score: r.score,
              matchedOn: r.matchedOn,
              description: r.description,
            })),
          };
        }),
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
        return;
      }

      if (opts.yaml) {
        process.stdout.write(toSimpleYaml(plan));
        return;
      }

      // Human output
      process.stdout.write(`Task plan for: "${opts.goal}"\n`);
      process.stdout.write(`Generated:     ${plan.generatedAt}\n\n`);

      for (let i = 0; i < plan.subtasks.length; i++) {
        const s = plan.subtasks[i];
        process.stdout.write(`Subtask ${i + 1}: ${s.title}\n`);
        process.stdout.write(`  Keywords: ${s.keywords.join(", ") || "(none)"}\n`);
        if (s.recommendedSkills.length > 0) {
          const skillLine = s.recommendedSkills
            .map((r) => `${r.name} (${r.score.toFixed(2)})`)
            .join(", ");
          process.stdout.write(`  Skills:   ${skillLine}\n`);
        } else {
          process.stdout.write("  Skills:   (no matching skills installed)\n");
        }
        process.stdout.write("\n");
      }

      // Session-create hints — informational only, does not create sessions
      const hasAnySkills = plan.subtasks.some((s) => s.recommendedSkills.length > 0);
      if (hasAnySkills) {
        process.stdout.write("To start sessions:\n");
        for (const s of plan.subtasks) {
          const flags = s.recommendedSkills.map((r) => `--skill ${r.name}`).join(" ");
          process.stdout.write(
            `  vi session create${flags ? ` ${flags}` : ""} --goal "${s.title}" --agent <id>\n`,
          );
        }
      }
    });
}
