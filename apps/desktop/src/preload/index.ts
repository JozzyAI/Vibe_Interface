import { contextBridge, ipcRenderer } from "electron";

export interface RelayConfig {
  baseUrl: string;
  token: string;
}

export interface ElectronAPI {
  getConfig(): Promise<RelayConfig | null>;
  setConfig(baseUrl: string, token: string): Promise<void>;
  clearConfig(): Promise<void>;
}

const api: ElectronAPI = {
  getConfig: () => ipcRenderer.invoke("config:get") as Promise<RelayConfig | null>,
  setConfig: (baseUrl, token) => ipcRenderer.invoke("config:set", baseUrl, token) as Promise<void>,
  clearConfig: () => ipcRenderer.invoke("config:clear") as Promise<void>,
};

contextBridge.exposeInMainWorld("electronAPI", api);
