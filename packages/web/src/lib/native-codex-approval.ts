export interface NativeCodexApprovalOption {
  key: string;
  label: string;
}

export interface NativeCodexApproval {
  kind: "command_execution";
  title: string;
  reason: string | null;
  command: string | null;
  prompt: string;
  options: {
    approve?: NativeCodexApprovalOption;
    alwaysApprove?: NativeCodexApprovalOption;
    reject?: NativeCodexApprovalOption;
  };
}

function extractPromptBlock(output: string): string | null {
  const marker = "Would you like to run the following command?";
  const start = output.lastIndexOf(marker);
  if (start < 0) return null;
  return output.slice(start).trim();
}

function extractOption(block: string, pattern: RegExp): NativeCodexApprovalOption | undefined {
  const match = block.match(pattern);
  if (!match) return undefined;
  return {
    label: match[1]?.trim() ?? "",
    key: match[2]?.trim() ?? "",
  };
}

export function parseNativeCodexApproval(output: string): NativeCodexApproval | null {
  const block = extractPromptBlock(output);
  if (!block) return null;

  const commandMatch = block.match(/^\s*\$\s+(.+)$/m);
  const reasonMatch = block.match(/^\s*Reason:\s+(.+)$/m);
  const approve = extractOption(block, /(?:^|\n).*?1\.\s+(.+?)\s+\(([^)]+)\)\s*(?:\n|$)/);
  const alwaysApprove = extractOption(
    block,
    /(?:^|\n).*?2\.\s+(.+?)\s+\(([^)]+)\)\s*(?:\n|$)/,
  );
  const reject = extractOption(block, /(?:^|\n).*?3\.\s+(.+?)\s+\(([^)]+)\)\s*(?:\n|$)/);

  if (!approve && !alwaysApprove && !reject) return null;

  return {
    kind: "command_execution",
    title: "Codex CLI is waiting for command approval",
    reason: reasonMatch?.[1]?.trim() ?? null,
    command: commandMatch?.[1]?.trim() ?? null,
    prompt: block,
    options: {
      approve,
      alwaysApprove,
      reject,
    },
  };
}
