import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getVISessionsRegistryDir } from "./paths.js";
import { createMockVISessions, type VISession } from "./types.js";

function sessionPath(sessionId: string): string {
  return join(getVISessionsRegistryDir(), `${sessionId}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(getVISessionsRegistryDir(), { recursive: true });
}

export async function listVISessions(): Promise<VISession[]> {
  await ensureDir();
  let entries: string[];
  try {
    entries = await readdir(getVISessionsRegistryDir());
  } catch {
    return getMockVISessions();
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  if (jsonFiles.length === 0) {
    return getMockVISessions();
  }

  const sessions = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const content = await readFile(join(getVISessionsRegistryDir(), file), "utf8");
        return JSON.parse(content) as VISession;
      } catch {
        return null;
      }
    }),
  );

  return sessions
    .filter((s): s is VISession => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getVISession(id: string): Promise<VISession | null> {
  try {
    const content = await readFile(sessionPath(id), "utf8");
    return JSON.parse(content) as VISession;
  } catch {
    return null;
  }
}

export async function upsertVISession(session: VISession): Promise<void> {
  await ensureDir();
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export async function deleteVISession(id: string): Promise<void> {
  try {
    await unlink(sessionPath(id));
  } catch {
    void 0;
  }
}

export function getMockVISessions(): VISession[] {
  return createMockVISessions();
}
