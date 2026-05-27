import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { exit, ExitCode } from "./exit.js";

const CONFIG_DIR = join(homedir(), ".vi");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface StoredConfig {
  baseUrl?: string;
  // TODO: migrate token to OS keychain
  token?: string;
}

function readStored(): StoredConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StoredConfig;
  } catch {
    return {};
  }
}

function writeStored(config: StoredConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export interface ResolvedConfig {
  baseUrl: string;
  viToken: string;
}

export function resolveConfig(): ResolvedConfig {
  const envBase = process.env["VI_RELAY_BASE_URL"]?.trim();
  const envToken = process.env["VI_RELAY_VI_TOKEN"]?.trim();
  const stored = readStored();

  const baseUrl = envBase ?? stored.baseUrl;
  const viToken = envToken ?? stored.token;

  if (!baseUrl || !viToken) {
    exit(
      ExitCode.USER_ERROR,
      "relay not configured.\n\nRun:\n  vi config set --base-url <url>\n  vi config set --token <token>\n\nOr set env vars:\n  VI_RELAY_BASE_URL=...\n  VI_RELAY_VI_TOKEN=...",
    );
  }

  return { baseUrl, viToken };
}

// ── Config subcommands ──────────────────────────────────────────────────────

export function configSet(opts: { baseUrl?: string; token?: string }): void {
  if (!opts.baseUrl && !opts.token) {
    exit(ExitCode.USER_ERROR, "specify at least --base-url or --token");
  }
  const current = readStored();
  if (opts.baseUrl) current.baseUrl = opts.baseUrl.trim().replace(/\/$/, "");
  if (opts.token) current.token = opts.token.trim();
  writeStored(current);
  if (opts.baseUrl) process.stdout.write(`Base URL saved.\n`);
  if (opts.token) process.stdout.write(`Token saved.\n`);
}

export function configShow(): void {
  const stored = readStored();
  const envBase = process.env["VI_RELAY_BASE_URL"]?.trim();
  const envToken = process.env["VI_RELAY_VI_TOKEN"]?.trim();

  const baseUrl = envBase ?? stored.baseUrl ?? "(not set)";
  const baseUrlSuffix = envBase ? "  [env]" : "";
  const tokenLabel = envToken ? "(set via env)" : stored.token ? "(set)" : "(not set)";

  process.stdout.write(`Base URL : ${baseUrl}${baseUrlSuffix}\n`);
  process.stdout.write(`Token    : ${tokenLabel}\n`);
  process.stdout.write(`Config   : ${CONFIG_FILE}\n`);
}

export function configClear(): void {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
    process.stdout.write("Config cleared.\n");
  } else {
    process.stdout.write("No config file found.\n");
  }
}
