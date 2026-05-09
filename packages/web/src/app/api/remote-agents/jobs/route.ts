import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { createRemoteAgentJob } from "@/lib/remote-agents";
import { dispatchRelayJob } from "@/lib/relay-dispatch";

type RemoteProvider = "codex" | "claude";

const PI_SESSION_INSTRUCTIONS = `

PI hook: host-side blockers belong in a separate PI utility session, not repo edits.
For GitHub login, Codex upgrades/restarts, host tool installs, browser login, or machine setup, run:
pi-remote-bridge request-pi-session --title "Short title" --message "What is needed and why" --command "host command or script"
`;

function withPiHookInstructions(prompt?: string): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("PI hook: host-side blockers")) return trimmed;
  return `${trimmed}${PI_SESSION_INSTRUCTIONS}`;
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
  const command = ["pi-remote-bridge", input.provider];
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
  if (providerArgs.length > 0) {
    command.push("--", ...codexOptions, ...providerArgs);
  } else if (input.prompt?.trim()) {
    command.push("--", ...codexOptions, withPiHookInstructions(input.prompt) ?? input.prompt.trim());
  } else if (codexOptions.length > 0) {
    command.push("--", ...codexOptions);
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
    const job = await createRemoteAgentJob({
      agentId: body.agentId,
      title,
      command,
      cwd: body.cwd,
      env: body.env,
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
