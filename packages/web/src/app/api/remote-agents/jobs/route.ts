import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteAgentsBackend } from "@/lib/backend";
import { dispatchRelayJob } from "@/lib/relay-dispatch";

type RemoteProvider = "codex" | "claude";

const VI_SESSION_INSTRUCTIONS = `

VI hook: host-side blockers belong in a separate VI utility session, not repo edits.
For GitHub login, Codex upgrades/restarts, host tool installs, browser login, or machine setup, run:
vi-agent request-vi-session --title "Short title" --message "What is needed and why" --command "host command or script"
`;

function withViHookInstructions(prompt?: string): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("VI hook: host-side blockers")) return trimmed;
  return `${trimmed}${VI_SESSION_INSTRUCTIONS}`;
}

function buildProviderCommand(input: {
  provider: RemoteProvider;
  prompt?: string;
  providerArgs?: string[];
  cwd?: string;
  binary?: string;
  model?: string;
  reasoningEffort?: string;
}): string[] {
  const command = ["vi-agent", input.provider];
  if (input.binary?.trim()) {
    command.push("--binary", input.binary.trim());
  }
  if (input.cwd?.trim()) {
    command.push("--cwd", input.cwd.trim());
  }
  const providerArgs = input.providerArgs?.map((part) => part.trim()).filter(Boolean) ?? [];
  const codexOptions =
    input.provider === "codex"
      ? [
          ...(input.model?.trim() ? ["-m", input.model.trim()] : []),
          ...(input.reasoningEffort?.trim()
            ? ["-c", `model_reasoning_effort="${input.reasoningEffort.trim()}"`]
            : []),
        ]
      : [];
  // Claude Code uses --model <value>.
  // Precedence: explicit model from UI > VI_CLAUDE_DEFAULT_MODEL env var > omit flag.
  // Never rely on shell aliases — vi-agent launches via subprocess, aliases are not expanded.
  const claudeModel =
    input.provider === "claude"
      ? (input.model?.trim() || process.env["VI_CLAUDE_DEFAULT_MODEL"]?.trim() || "")
      : "";
  const claudeOptions = claudeModel ? ["--model", claudeModel] : [];
  const extraOptions = [...codexOptions, ...claudeOptions];
  if (providerArgs.length > 0) {
    command.push("--", ...extraOptions, ...providerArgs);
  } else if (input.prompt?.trim()) {
    if (input.provider === "claude") {
      // Claude Code treats a positional text arg as a one-shot non-interactive task and exits.
      // Only pass launch flags here; the prompt is injected into the live REPL via tmux
      // after startup (see VI_INITIAL_PROMPT in the job env).
      if (extraOptions.length > 0) {
        command.push("--", ...extraOptions);
      }
    } else {
      command.push("--", ...extraOptions, withViHookInstructions(input.prompt) ?? input.prompt.trim());
    }
  } else if (extraOptions.length > 0) {
    command.push("--", ...extraOptions);
  }
  return command;
}

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as {
      agentId: string;
      title?: string;
      provider?: RemoteProvider;
      prompt?: string;
      providerArgs?: string[];
      command?: string[];
      cwd?: string;
      binary?: string;
      env?: Record<string, string>;
      ralphEnabled?: boolean;
      autoResumeUsageLimit?: boolean;
      autoRestartCodex?: boolean;
      model?: string;
      reasoningEffort?: string;
    };
    const command =
      body.provider === "codex" || body.provider === "claude"
        ? buildProviderCommand({
            provider: body.provider,
            prompt: body.prompt,
            providerArgs: body.providerArgs,
            cwd: body.cwd,
            binary: body.binary,
            model: body.model,
            reasoningEffort: body.reasoningEffort,
          })
        : body.command;
    if (!Array.isArray(command) || command.length === 0) {
      throw new Error("Remote agent job requires a provider or a non-empty command");
    }
    const title =
      body.title?.trim() ||
      (body.provider === "codex"
        ? "Start Codex CLI via bridge"
        : body.provider === "claude"
          ? "Start Claude Code via bridge"
          : undefined);
    // For Claude sessions, the initial prompt must be injected into the live REPL via
    // tmux after startup — not passed as a positional CLI arg (which triggers one-shot exit).
    // VI_INITIAL_GOAL carries the clean user prompt for /plan injection.
    // VI hook instructions are already present via CLAUDE.md and VI_HOOK_* env vars;
    // they must not be included in the /plan text.
    const jobEnv: Record<string, string> = { ...(body.env ?? {}) };
    if (body.provider === "claude" && body.prompt?.trim()) {
      jobEnv["VI_INITIAL_GOAL"] = body.prompt.trim();
    }
    const { createRemoteAgentJob } = await getRemoteAgentsBackend();
    const job = await createRemoteAgentJob({
      agentId: body.agentId,
      title,
      command,
      cwd: body.cwd,
      env: Object.keys(jobEnv).length > 0 ? jobEnv : body.env,
      ralphEnabled: body.ralphEnabled,
      autoResumeUsageLimit: body.autoResumeUsageLimit,
      autoRestartCodex: body.autoRestartCodex,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
    });
    const relayDispatch = await dispatchRelayJob(job.agentId, job);
    return jsonWithCorrelation({ job, relayDispatch }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create remote agent job" },
      { status: 500 },
      correlationId,
    );
  }
}
