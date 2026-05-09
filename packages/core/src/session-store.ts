import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPISessionsRegistryDir } from "./paths.js";
import { createMockPISessions, type PISession } from "./types.js";

function sessionPath(sessionId: string): string {
  return join(getPISessionsRegistryDir(), `${sessionId}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(getPISessionsRegistryDir(), { recursive: true });
}

export async function listPISessions(): Promise<PISession[]> {
  await ensureDir();
  let entries: string[];
  try {
    entries = await readdir(getPISessionsRegistryDir());
  } catch {
    return getMockPISessions();
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  if (jsonFiles.length === 0) {
    return getMockPISessions();
  }

  const sessions = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const content = await readFile(join(getPISessionsRegistryDir(), file), "utf8");
        return JSON.parse(content) as PISession;
      } catch {
        return null;
      }
    }),
  );

  return sessions
    .filter((s): s is PISession => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getPISession(id: string): Promise<PISession | null> {
  try {
    const content = await readFile(sessionPath(id), "utf8");
    return JSON.parse(content) as PISession;
  } catch {
    return null;
  }
}

export async function upsertPISession(session: PISession): Promise<void> {
  await ensureDir();
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export async function deletePISession(id: string): Promise<void> {
  try {
    await unlink(sessionPath(id));
  } catch {
    void 0;
  }
}

export function getMockPISessions(): PISession[] {
  return createMockPISessions();
}
