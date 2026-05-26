import { ipcMain } from "electron";
import { getConfig, setConfig, clearConfig } from "./store";

export function registerIpcHandlers(): void {
  ipcMain.handle("config:get", () => getConfig());
  ipcMain.handle("config:set", (_event, baseUrl: string, token: string) => {
    setConfig(baseUrl, token);
  });
  ipcMain.handle("config:clear", () => clearConfig());
}
