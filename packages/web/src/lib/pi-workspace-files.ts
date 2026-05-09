import "server-only";

import { readdir } from "node:fs/promises";

export async function readPIWorkspaceFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".git"))
      .sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) return -1;
        if (!left.isDirectory() && right.isDirectory()) return 1;
        return left.name.localeCompare(right.name);
      })
      .slice(0, 28)
      .map((entry) => entry.name);
  } catch {
    return ["PI", "README.md"];
  }
}
