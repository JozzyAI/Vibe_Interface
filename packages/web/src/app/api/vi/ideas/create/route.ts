import { type NextRequest } from "next/server";
import { createVIIdeaPlan } from "@vi/core";
import { getServices } from "@/lib/services";
import { createIssueViaGitHubConnector } from "@/lib/github-connector-api";
import { validateConfiguredProject, validateString } from "@/lib/validation";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const projectErr = validateString(body.projectId, "projectId", 128);
  if (projectErr) return jsonWithCorrelation({ error: projectErr }, { status: 400 }, correlationId);

  const titleErr = validateString(body.title, "title", 160);
  if (titleErr) return jsonWithCorrelation({ error: titleErr }, { status: 400 }, correlationId);

  const descriptionErr = validateString(body.description, "description", 5000);
  if (descriptionErr) return jsonWithCorrelation({ error: descriptionErr }, { status: 400 }, correlationId);

  const { config } = await getServices();
  const projectId = body.projectId as string;
  const configuredProjectErr = validateConfiguredProject(config.projects, projectId);
  if (configuredProjectErr) return jsonWithCorrelation({ error: configuredProjectErr }, { status: 404 }, correlationId);

  const plan = createVIIdeaPlan({
    projectId,
    title: (body.title as string).trim(),
    description: (body.description as string).trim(),
    labels: Array.isArray(body.labels)
      ? body.labels.filter((v): v is string => typeof v === "string")
      : [],
    priority:
      body.priority === "low" || body.priority === "medium" ||
      body.priority === "high" || body.priority === "critical"
        ? body.priority
        : undefined,
    source: "dashboard",
  });

  // Always use GitHub connector
  const created: Array<{ id: string; title: string; url: string; labels: string[] }> = [];
  for (const issue of plan.issues) {
    const result = await createIssueViaGitHubConnector(config, projectId, {
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
    });
    if (!result) {
      return jsonWithCorrelation(
        { error: "No active GitHub connector with a default repo is configured for this project." },
        { status: 400 },
        correlationId,
      );
    }
    created.push({ id: result.id, title: result.title, url: result.url, labels: result.labels });
  }

  return jsonWithCorrelation({ plan, created }, { status: 201 }, correlationId);
}
