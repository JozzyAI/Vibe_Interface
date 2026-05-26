/**
 * TEMPORARY: config stored as plain JSON at app.getPath('userData')/vi-config.json.
 * TODO: migrate viToken to OS keychain via keytar before shipping to real users.
 *   macOS → Keychain, Windows → Credential Manager
 */
import { app } from "electron";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

interface RawConfig {
  relayBaseUrl?: string;
  viToken?: string;
}

function configPath(): string {
  return join(app.getPath("userData"), "vi-config.json");
}

function read(): RawConfig {
  try {
    if (existsSync(configPath())) {
      return JSON.parse(readFileSync(configPath(), "utf-8")) as RawConfig;
    }
  } catch {
    // corrupted — start fresh
  }
  return {};
}

function persist(cfg: RawConfig): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
}

export interface RelayConfig {
  baseUrl: string;
  token: string;
}

export function getConfig(): RelayConfig | null {
  const c = read();
  if (!c.relayBaseUrl?.trim() || !c.viToken?.trim()) return null;
  return { baseUrl: c.relayBaseUrl.trim(), token: c.viToken.trim() };
}

export function setConfig(baseUrl: string, token: string): void {
  persist({ ...read(), relayBaseUrl: baseUrl.trim(), viToken: token.trim() });
}

export function clearConfig(): void {
  persist({ relayBaseUrl: "", viToken: "" });
}
