export const ExitCode = {
  SUCCESS: 0,
  USER_ERROR: 1,
  RELAY_ERROR: 2,
  NOT_FOUND: 3,
  READ_ONLY: 4,
} as const;

export function guardReadOnly(): void {
  if (process.env["VI_CLI_READ_ONLY"] === "1") {
    exit(ExitCode.READ_ONLY, "write commands are disabled (VI_CLI_READ_ONLY=1)");
  }
}

export function exit(code: number, message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

export async function withRelay<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    exit(ExitCode.RELAY_ERROR, err instanceof Error ? err.message : String(err));
  }
}
