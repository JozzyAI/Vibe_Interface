import "server-only";

import { cache } from "react";
import { getPIServices } from "@/lib/services";

export interface ProjectInfo {
  id: string;
  name: string;
  sessionPrefix?: string;
}

export const getProjectName = cache((): string => {
  try {
    const { config } = getPIServices();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) {
      return config.projects[firstKey]?.name ?? firstKey;
    }
  } catch {
    void 0;
  }
  return "PI";
});

export const getPrimaryProjectId = cache((): string => {
  try {
    const { config } = getPIServices();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) return firstKey;
  } catch {
    void 0;
  }
  return "default";
});

export const getAllProjects = cache((): ProjectInfo[] => {
  try {
    const { config } = getPIServices();
    return Object.entries(config.projects).map(([id, project]) => ({
      id,
      name: project.name ?? id,
      sessionPrefix: project.sessionPrefix ?? id,
    }));
  } catch {
    return [];
  }
});
