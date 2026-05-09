import type { RelayPeerKind } from "./types.js";

export interface RelayTokenRecord {
  token: string;
  kind?: RelayPeerKind;
  label?: string;
}

const DEFAULT_TOKENS = ["pi-dev-token:pi:local-pi", "daemon-dev-token:daemon:local-daemon"];

export function loadRelayTokens(rawValue = process.env.PI_RELAY_TOKENS): RelayTokenRecord[] {
  const source = rawValue?.trim() ? rawValue : DEFAULT_TOKENS.join(",");
  return source
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
  const matched = tokenRecords.find((record) => record.token === token);
  if (!matched) {
    return null;
  }

  if (matched.kind && matched.kind !== kind) {
    return null;
  }

  return matched;
}
