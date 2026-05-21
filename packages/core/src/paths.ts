import { homedir } from "node:os";
import { join } from "node:path";

const VI_HOME = join(homedir(), ".pi");

export function getVIHomeDir(): string {
  return VI_HOME;
}

export function getVIProjectBaseDir(projectId: string): string {
  return join(VI_HOME, "projects", projectId);
}

export function getVISessionsDir(projectId: string): string {
  return join(getVIProjectBaseDir(projectId), "pi-state");
}

export function getVIObservabilityDir(): string {
  return join(VI_HOME, "observability");
}

export function getVIRemoteAgentsDir(): string {
  return join(VI_HOME, "remote-agents");
}

export function getVISessionsRegistryDir(): string {
  return join(VI_HOME, "sessions");
}

// Compatibility shims so pi-control-plane.ts function signatures stay stable.
// configPath is ignored; projectPath's basename is used as the projectId.
import { basename } from "node:path";

export function getProjectBaseDir(_configPath: string, projectPath: string): string {
  const projectId = basename(projectPath) || "default";
  return getVIProjectBaseDir(projectId);
}

export function getObservabilityBaseDir(_configPath: string): string {
  return getVIObservabilityDir();
}
