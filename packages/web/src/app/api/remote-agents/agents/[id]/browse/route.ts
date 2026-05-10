import { readdir, mkdir } from "node:fs/promises";
import { join, resolve, normalize } from "node:path";
import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { getRemoteApprovalOverview } from "@/lib/remote-agents";

export interface BrowseEntry {
  name: string;
  isDir: boolean;
}

export interface BrowseResult {
  path: string;
  entries: BrowseEntry[];
  agentRoot: string;
}

async function resolveAgentRoot(agentId: string): Promise<string | null> {
  const overview = await getRemoteApprovalOverview();
  const agent = overview.agents.find((a) => a.agentId === agentId);
  if (!agent) return null;
  return agent.worktree ?? agent.repoRoot ?? null;
}

function guardPath(requested: string, agentRoot: string): string | null {
  const safe = resolve(normalize(requested));
  // Must stay within agentRoot
  if (!safe.startsWith(agentRoot)) return null;
  return safe;
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id: agentId } = await props.params;
    const agentRoot = await resolveAgentRoot(agentId);
    if (!agentRoot) {
      return jsonWithCorrelation({ error: "Agent not found or has no root directory" }, { status: 404 }, correlationId);
    }

    const rawPath = request.nextUrl.searchParams.get("path") ?? agentRoot;
    const safePath = guardPath(rawPath, agentRoot);
    if (!safePath) {
      return jsonWithCorrelation({ error: "Path is outside agent root" }, { status: 400 }, correlationId);
    }

    const entries = await readdir(safePath, { withFileTypes: true });
    const result: BrowseResult = {
      path: safePath,
      agentRoot,
      entries: entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ name: e.name, isDir: true })),
    };
    return jsonWithCorrelation(result, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to browse directory" },
      { status: 500 },
      correlationId,
    );
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id: agentId } = await props.params;
    const agentRoot = await resolveAgentRoot(agentId);
    if (!agentRoot) {
      return jsonWithCorrelation({ error: "Agent not found or has no root directory" }, { status: 404 }, correlationId);
    }

    const body = (await request.json()) as { parent: string; name: string };
    if (!body.name || /[/\\:*?"<>|]/.test(body.name)) {
      return jsonWithCorrelation({ error: "Invalid folder name" }, { status: 400 }, correlationId);
    }

    const parentPath = guardPath(body.parent, agentRoot);
    if (!parentPath) {
      return jsonWithCorrelation({ error: "Path is outside agent root" }, { status: 400 }, correlationId);
    }

    const newPath = join(parentPath, body.name);
    await mkdir(newPath, { recursive: true });
    return jsonWithCorrelation({ path: newPath }, { status: 201 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create folder" },
      { status: 500 },
      correlationId,
    );
  }
}
