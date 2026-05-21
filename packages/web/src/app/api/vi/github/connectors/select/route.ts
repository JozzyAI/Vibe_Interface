import { type NextRequest } from "next/server";
import { selectVIGitHubConnector, type VIGitHubConnectorStore } from "@vi/core";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { validateConfiguredProject, validateString } from "@/lib/validation";

function sanitizeStore(
  store: VIGitHubConnectorStore,
) {
  return {
    selectedConnectorId: store.selectedConnectorId,
    connectors: store.connectors.map((connector) => ({
      id: connector.id,
      label: connector.label,
      host: connector.host,
      accountLogin: connector.accountLogin,
      owner: connector.owner,
      repo: connector.repo,
      authType: connector.authType,
      tokenPreview: connector.tokenPreview,
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
      isSelected: connector.id === store.selectedConnectorId,
    })),
  };
}

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

  const connectorErr = validateString(body.connectorId, "connectorId", 160);
  if (connectorErr) {
    return jsonWithCorrelation({ error: connectorErr }, { status: 400 }, correlationId);
  }

  try {
    const store = await selectVIGitHubConnector(
      config.configPath,
      config.projects[projectId].path,
      (body.connectorId as string).trim(),
    );
    return jsonWithCorrelation(sanitizeStore(store), { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to select connector" },
      { status: 400 },
      correlationId,
    );
  }
}
