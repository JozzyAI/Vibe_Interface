import { VIRelayClient } from "@vi/client-sdk";
import { resolveConfig } from "./config.js";

export function getClient(): VIRelayClient {
  const { baseUrl, viToken } = resolveConfig();
  return new VIRelayClient({ baseUrl, viToken });
}
