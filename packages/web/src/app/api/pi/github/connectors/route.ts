import { type NextRequest } from "next/server";
import { listPIGitHubConnectors, upsertPIGitHubConnector, type PIGitHubConnectorStore } from "@pi/core";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { validateConfiguredProject, validateString } from "@/lib/validation";

function sanitizeStore(
  store: PIGitHubConnectorStore,
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

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const { config } = await getServices();
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project");

  if (!projectId) {
    return jsonWithCorrelation({ error: "project is required" }, { status: 400 }, correlationId);
  }

  const configuredProjectErr = validateConfiguredProject(config.projects, projectId);
  if (configuredProjectErr) {
    return jsonWithCorrelation({ error: configuredProjectErr }, { status: 404 }, correlationId);
  }

  const store = await listPIGitHubConnectors(config.configPath, config.projects[projectId].path);
  return jsonWithCorrelation(sanitizeStore(store), { status: 200 }, correlationId);
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

  const currentStore = await listPIGitHubConnectors(config.configPath, config.projects[projectId].path);
  const connectorId =
    typeof body.id === "string" && body.id.trim().length > 0 ? body.id.trim() : undefined;
  const existingConnector = connectorId
    ? currentStore.connectors.find((connector) => connector.id === connectorId)
    : undefined;

  const labelErr = validateString(body.label, "label", 120);
  if (labelErr) {
    return jsonWithCorrelation({ error: labelErr }, { status: 400 }, correlationId);
  }

  const loginErr = validateString(body.accountLogin, "accountLogin", 120);
  if (loginErr) {
    return jsonWithCorrelation({ error: loginErr }, { status: 400 }, correlationId);
  }

  const ownerErr = validateString(body.owner, "owner", 120);
  if (ownerErr) {
    return jsonWithCorrelation({ error: ownerErr }, { status: 400 }, correlationId);
  }

  const repoErr = validateString(body.repo, "repo", 120);
  if (repoErr) {
    return jsonWithCorrelation({ error: repoErr }, { status: 400 }, correlationId);
  }

  if (
    (body.accessToken !== undefined && body.accessToken !== null) ||
    !existingConnector
  ) {
    const tokenErr = validateString(body.accessToken, "accessToken", 4096);
    if (tokenErr) {
      return jsonWithCorrelation({ error: tokenErr }, { status: 400 }, correlationId);
    }
  }

  const host = typeof body.host === "string" && body.host.trim() ? body.host.trim() : "github.com";

  const store = await upsertPIGitHubConnector(config.configPath, config.projects[projectId].path, {
    id: connectorId,
    label: (body.label as string).trim(),
    host,
    accountLogin: (body.accountLogin as string).trim(),
    owner: (body.owner as string).trim(),
    repo: (body.repo as string).trim(),
    accessToken: typeof body.accessToken === "string" ? body.accessToken.trim() : undefined,
    authType:
      body.authType === "oauth" || body.authType === "personal_access_token"
        ? body.authType
        : existingConnector?.authType,
    setAsSelected: body.setAsSelected !== false,
  });

  return jsonWithCorrelation(sanitizeStore(store), { status: 201 }, correlationId);
}
