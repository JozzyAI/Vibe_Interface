export {};

declare global {
  interface RelayConfig {
    baseUrl: string;
    token: string;
  }

  interface ElectronAPI {
    getConfig(): Promise<RelayConfig | null>;
    setConfig(baseUrl: string, token: string): Promise<void>;
    clearConfig(): Promise<void>;
  }

  interface Window {
    electronAPI: ElectronAPI;
  }
}
