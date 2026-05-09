import { type NextRequest } from "next/server";
import {
  createPIIdea,
  getPIIdeaBoard,
  movePIIdeas,
  resolvePIIdeaProjectId,
  updatePIIdea,
} from "@/lib/pi-ideas";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { validateIdentifier, validateString } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const url = new URL(request.url);
    const projectId = await resolvePIIdeaProjectId(url.searchParams.get("project")?.trim());

    const data = await getPIIdeaBoard(projectId);
    return jsonWithCorrelation(data, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load idea board" },
      { status: 500 },
      correlationId,
    );
  }
}

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
    }

    const projectId =
      typeof body.projectId === "string"
        ? await resolvePIIdeaProjectId(body.projectId)
        : await resolvePIIdeaProjectId();
    const titleErr = validateString(body.title, "title", 160);
    if (titleErr) {
      return jsonWithCorrelation({ error: titleErr }, { status: 400 }, correlationId);
    }
    const markdownErr = validateString(body.markdown, "markdown", 20000);
    if (markdownErr) {
      return jsonWithCorrelation({ error: markdownErr }, { status: 400 }, correlationId);
    }

    const data = await createPIIdea({
      projectId,
      title: body.title as string,
      markdown: body.markdown as string,
    });
    return jsonWithCorrelation(data, { status: 201 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create idea" },
      { status: 500 },
      correlationId,
    );
  }
}

export async function PATCH(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
    }

    const projectId =
      typeof body.projectId === "string"
        ? await resolvePIIdeaProjectId(body.projectId)
        : await resolvePIIdeaProjectId();

    if (body.action === "update") {
      const ideaErr = validateIdentifier(body.ideaId, "ideaId", 128);
      if (ideaErr) {
        return jsonWithCorrelation({ error: ideaErr }, { status: 400 }, correlationId);
      }
      const titleErr = validateString(body.title, "title", 160);
      if (titleErr) {
        return jsonWithCorrelation({ error: titleErr }, { status: 400 }, correlationId);
      }
      const markdownErr = validateString(body.markdown, "markdown", 20000);
      if (markdownErr) {
        return jsonWithCorrelation({ error: markdownErr }, { status: 400 }, correlationId);
      }

      const data = await updatePIIdea({
        projectId,
        ideaId: body.ideaId as string,
        title: body.title as string,
        markdown: body.markdown as string,
      });
      return jsonWithCorrelation(data, { status: 200 }, correlationId);
    }

    const columns = body.columns;
    if (!columns || typeof columns !== "object") {
      return jsonWithCorrelation({ error: "columns is required" }, { status: 400 }, correlationId);
    }

    const data = await movePIIdeas({
      projectId,
      columns: {
        idea_bank: Array.isArray((columns as Record<string, unknown>).idea_bank)
          ? ((columns as Record<string, unknown>).idea_bank as unknown[]).filter((value): value is string => typeof value === "string")
          : [],
        project_queue: Array.isArray((columns as Record<string, unknown>).project_queue)
          ? ((columns as Record<string, unknown>).project_queue as unknown[]).filter((value): value is string => typeof value === "string")
          : [],
        working: Array.isArray((columns as Record<string, unknown>).working)
          ? ((columns as Record<string, unknown>).working as unknown[]).filter((value): value is string => typeof value === "string")
          : [],
        done: Array.isArray((columns as Record<string, unknown>).done)
          ? ((columns as Record<string, unknown>).done as unknown[]).filter((value): value is string => typeof value === "string")
          : [],
      },
    });

    return jsonWithCorrelation(data, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to update idea board" },
      { status: 500 },
      correlationId,
    );
  }
}
