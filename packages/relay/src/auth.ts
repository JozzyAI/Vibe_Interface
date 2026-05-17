import type { RelayPeerKind } from "./types.js";

export interface RelayTokenRecord {
  token: string;
  kind?: RelayPeerKind;
  label?: string;
}

export function loadRelayTokens(rawValue = process.env.PI_RELAY_TOKENS): RelayTokenRecord[] {
  const raw = rawValue?.trim();
  if (!raw) {
    // No tokens configured — refuse all authenticated requests.
    // In production, PI_RELAY_TOKENS must be set via fly secrets set.
    // Do NOT fall back to dev tokens: they are public in source control.
    console.warn(
      "[Auth] WARNING: PI_RELAY_TOKENS is not set. " +
      "All authenticated endpoints will reject every request. " +
      "Set PI_RELAY_TOKENS before deploying.",
    );
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":");
      const token = parts[0] ?? "";
      const kind = parts[1];
      const label = parts[2];
      return {
        token,
        kind: kind === "pi" || kind === "daemon" ? kind : undefined,
        label: label || undefined,
      } satisfies RelayTokenRecord;
    })
    .filter((record) => record.token.length > 0) as RelayTokenRecord[];
}

export function authorizeRelayToken(
  tokenRecords: RelayTokenRecord[],
  token: string,
  kind: RelayPeerKind,
): RelayTokenRecord | null {
  if (tokenRecords.length === 0) return null;
  const matched = tokenRecords.find((record) => record.token === token);
  if (!matched) return null;
  if (matched.kind && matched.kind !== kind) return null;
  return matched;
}
