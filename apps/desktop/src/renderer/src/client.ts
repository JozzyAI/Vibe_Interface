import { VIRelayClient } from "@vi/client-sdk";

let _client: VIRelayClient | null = null;
let _clientBaseUrl = "";

export async function getClient(): Promise<VIRelayClient> {
  const config = await window.electronAPI.getConfig();
  if (!config) throw new Error("Not configured — open Setup to connect");
  if (!_client || config.baseUrl !== _clientBaseUrl) {
    _client = new VIRelayClient({ baseUrl: config.baseUrl, viToken: config.token });
    _clientBaseUrl = config.baseUrl;
  }
  return _client;
}

export function invalidateClient(): void {
  _client = null;
  _clientBaseUrl = "";
}
