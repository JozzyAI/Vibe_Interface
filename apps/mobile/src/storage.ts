import * as SecureStore from "expo-secure-store";

const KEY_BASE_URL = "vi_relay_base_url";
const KEY_TOKEN = "vi_relay_token";

export interface RelayConfig {
  baseUrl: string;
  token: string;
}

export async function saveConfig(config: RelayConfig): Promise<void> {
  await SecureStore.setItemAsync(KEY_BASE_URL, config.baseUrl.trim());
  await SecureStore.setItemAsync(KEY_TOKEN, config.token.trim());
}

export async function loadConfig(): Promise<RelayConfig | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(KEY_BASE_URL),
    SecureStore.getItemAsync(KEY_TOKEN),
  ]);
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_BASE_URL),
    SecureStore.deleteItemAsync(KEY_TOKEN),
  ]);
}
