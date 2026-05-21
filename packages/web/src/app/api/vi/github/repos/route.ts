import { type NextRequest } from "next/server";
import { createRepositoryViaGitHubConnector } from "@/lib/github-connector-api";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { validateConfiguredProject, validateString } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const { config } = await getServices();

  const projectErr = validateString(body.projectId, "projectId", 128);
  if (projectErr) {
    return jsonWithCorrelation({ error: projectErr }, { status: 400 }, correlationId);
  }
  const projectId = (body.projectId as string).trim();

  const configuredProjectErr = validateConfiguredProject(config.projects, projectId);
  if (configuredProjectErr) {
    return jsonWithCorrelation({ error: configuredProjectErr }, { status: 404 }, correlationId);
  }

  const nameErr = validateString(body.name, "name", 120);
  if (nameErr) {
    return jsonWithCorrelation({ error: nameErr }, { status: 400 }, correlationId);
  }

  const ownerErr =
    body.owner === undefined || body.owner === null
      ? null
      : validateString(body.owner, "owner", 120);
  if (ownerErr) {
    return jsonWithCorrelation({ error: ownerErr }, { status: 400 }, correlationId);
  }

  const descriptionErr =
    body.description === undefined || body.description === null
      ? null
      : validateString(body.description, "description", 5000);
  if (descriptionErr) {
    return jsonWithCorrelation({ error: descriptionErr }, { status: 400 }, correlationId);
  }

  const visibility =
    body.visibility === "public" || body.visibility === "private"
      ? body.visibility
      : "private";

  try {
    const created = await createRepositoryViaGitHubConnector(config, projectId, {
      owner: typeof body.owner === "string" ? body.owner.trim() : undefined,
      name: (body.name as string).trim(),
      description: typeof body.description === "string" ? body.description.trim() : undefined,
      visibility,
    });

    if (!created) {
      return jsonWithCorrelation(
        { error: "No active GitHub connector found for this project." },
        { status: 400 },
        correlationId,
      );
    }

    return jsonWithCorrelation({ repository: created }, { status: 201 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create repository" },
      { status: 500 },
      correlationId,
    );
  }
}
