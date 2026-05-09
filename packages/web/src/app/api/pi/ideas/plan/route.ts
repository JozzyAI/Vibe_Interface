import { type NextRequest } from "next/server";
import { createPIIdeaPlan } from "@pi/core";
import { getServices } from "@/lib/services";
import { validateConfiguredProject, validateString } from "@/lib/validation";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const projectErr = validateString(body.projectId, "projectId", 128);
  if (projectErr) {
    return jsonWithCorrelation({ error: projectErr }, { status: 400 }, correlationId);
  }

  const titleErr = validateString(body.title, "title", 160);
  if (titleErr) {
    return jsonWithCorrelation({ error: titleErr }, { status: 400 }, correlationId);
  }

  const descriptionErr = validateString(body.description, "description", 5000);
  if (descriptionErr) {
    return jsonWithCorrelation({ error: descriptionErr }, { status: 400 }, correlationId);
  }

  const { config } = await getServices();
  const projectId = body.projectId as string;
  const configuredProjectErr = validateConfiguredProject(config.projects, projectId);
  if (configuredProjectErr) {
    return jsonWithCorrelation({ error: configuredProjectErr }, { status: 404 }, correlationId);
  }

  const plan = createPIIdeaPlan({
    projectId,
    title: (body.title as string).trim(),
    description: (body.description as string).trim(),
    labels: Array.isArray(body.labels)
      ? body.labels.filter((value): value is string => typeof value === "string")
      : [],
    priority:
      body.priority === "low" ||
      body.priority === "medium" ||
      body.priority === "high" ||
      body.priority === "critical"
        ? body.priority
        : undefined,
    source: "dashboard",
  });

  return jsonWithCorrelation({ plan }, { status: 200 }, correlationId);
}
