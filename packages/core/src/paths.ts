import { homedir } from "node:os";
import { join } from "node:path";

const PI_HOME = join(homedir(), ".pi");

export function getPIHomeDir(): string {
  return PI_HOME;
}

export function getPIProjectBaseDir(projectId: string): string {
  return join(PI_HOME, "projects", projectId);
}

export function getPISessionsDir(projectId: string): string {
  return join(getPIProjectBaseDir(projectId), "pi-state");
}

export function getPIObservabilityDir(): string {
  return join(PI_HOME, "observability");
}

export function getPIRemoteAgentsDir(): string {
  return join(PI_HOME, "remote-agents");
}

export function getPISessionsRegistryDir(): string {
  return join(PI_HOME, "sessions");
}

// Compatibility shims so pi-control-plane.ts function signatures stay stable.
// configPath is ignored; projectPath's basename is used as the projectId.
import { basename } from "node:path";

export function getProjectBaseDir(_configPath: string, projectPath: string): string {
  const projectId = basename(projectPath) || "default";
  return getPIProjectBaseDir(projectId);
}

export function getObservabilityBaseDir(_configPath: string): string {
  return getPIObservabilityDir();
}
