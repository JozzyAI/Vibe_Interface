/**
 * backend.ts — mode switching for remote-agent operations.
 *
 * Local mode  (default): reads/writes local data/store.json via remote-agents.ts
 * Cloud mode  (PI_RELAY_BASE_URL + PI_RELAY_PI_TOKEN set): calls relay /v1/pi/*
 *
 * All callers use getBackend() so the switch is in one place.
 */
import "server-only";

export function isCloudMode(): boolean {
  return !!(
    process.env["PI_RELAY_BASE_URL"]?.trim() &&
    process.env["PI_RELAY_PI_TOKEN"]?.trim()
  );
}

/**
 * Import the correct backend module for the current mode.
 * Usage:
 *   const { createRemoteAgentJob } = await getRemoteAgentsBackend();
 *
 * Both modules export functions with the same names and compatible signatures
 * so callers need no mode-specific logic.
 */
export async function getRemoteAgentsBackend() {
  if (isCloudMode()) {
    return import("./relay-cloud-client");
  }
  return import("./remote-agents");
}

/**
 * Synchronous version using dynamic require — only for use in route files
 * that already know they need a specific function at request time.
 * Prefer getRemoteAgentsBackend() for new code.
 */
export function getBackend() {
  if (isCloudMode()) {
    // Use require-style lazy import via a preloaded module reference.
    // Route files call this at the top of their handler after await.
    return {
      mode: "cloud" as const,
      relayBase: (process.env["PI_RELAY_BASE_URL"] ?? "").trim(),
    };
  }
  return {
    mode: "local" as const,
  };
}
