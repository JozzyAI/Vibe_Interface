import "server-only";

import {
  listVIGitHubConnectors,
  upsertVIGitHubConnector,
  type CreateIssueInput,
  type VIGitHubConnectorRecord,
} from "@vi/core";
import type { VIConfig, VIProjectConfig } from "@/lib/services";

// VI-owned definitions for GitHub issue types
export interface Issue {
  id: string;
  title: string;
  description: string;
  url: string;
  state: "open" | "in_progress" | "closed" | "cancelled";
  labels: string[];
  assignee?: string;
}

export interface IssueFilters {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueUpdate {
  state?: "open" | "in_progress" | "closed";
  labels?: string[];
  removeLabels?: string[];
  assignee?: string;
  comment?: string;
}

// In VI, all projects use GitHub connectors — tracker/scm plugin not needed
function isGitHubProject(_project: VIProjectConfig): boolean {
  return true;
}


function getConnectorRepo(project: VIProjectConfig, connector: VIGitHubConnectorRecord) {
  const owner = connector.owner.trim();
  const repo = connector.repo.trim();
  if (!owner) {
    throw new Error(`GitHub connector "${connector.label}" is missing owner`);
  }
  return { owner, repo };
}

async function getSelectedConnector(
  config: VIConfig,
  project: VIProjectConfig,
): Promise<VIGitHubConnectorRecord | null> {
  if (!config.configPath || !isGitHubProject(project)) return null;
  const store = await listVIGitHubConnectors(config.configPath, project.path);
  if (!store.selectedConnectorId) return null;
  return store.connectors.find((connector) => connector.id === store.selectedConnectorId) ?? null;
}

async function githubRequest<T>(
  connector: VIGitHubConnectorRecord,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://api.${connector.host}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${connector.accessToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GitHub API ${init?.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  return (await response.json()) as T;
}

function mapGitHubIssue(
  raw: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    state: string;
    state_reason?: string | null;
    labels?: Array<{ name?: string }>;
    assignees?: Array<{ login?: string }>;
    pull_request?: unknown;
  },
): Issue | null {
  if ("pull_request" in raw && raw.pull_request) {
    return null;
  }

  return {
    id: String(raw.number),
    title: raw.title,
    description: raw.body ?? "",
    url: raw.html_url,
    state:
      raw.state === "closed"
        ? raw.state_reason === "not_planned"
          ? "cancelled"
          : "closed"
        : "open",
    labels: (raw.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
    assignee: raw.assignees?.find((assignee) => assignee.login)?.login,
  };
}

export async function getSelectedGitHubConnectorForProject(
  config: VIConfig,
  projectId: string,
): Promise<VIGitHubConnectorRecord | null> {
  const project = config.projects[projectId];
  if (!project) return null;
  return getSelectedConnector(config, project);
}

export async function createIssueViaGitHubConnector(
  config: VIConfig,
  projectId: string,
  input: CreateIssueInput,
): Promise<Issue | null> {
  const project = config.projects[projectId];
  if (!project) return null;
  const connector = await getSelectedConnector(config, project);
  if (!connector) return null;
  if (!connector.owner.trim() || !connector.repo.trim()) return null;

  const target = getConnectorRepo(project, connector);
  const created = await githubRequest<{
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    state: string;
    state_reason?: string | null;
    labels?: Array<{ name?: string }>;
    assignees?: Array<{ login?: string }>;
  }>(connector, `/repos/${target.owner}/${target.repo}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      body: input.description ?? "",
      labels: input.labels ?? [],
      assignees: input.assignee ? [input.assignee] : undefined,
    }),
  });

  const mapped = mapGitHubIssue(created);
  if (!mapped) {
    throw new Error("Created GitHub issue unexpectedly resolved to a pull request");
  }
  return mapped;
}

export async function listIssuesViaGitHubConnector(
  config: VIConfig,
  projectId: string,
  filters: IssueFilters,
): Promise<Issue[] | null> {
  const project = config.projects[projectId];
  if (!project) return null;
  const connector = await getSelectedConnector(config, project);
  if (!connector) return null;
  if (!connector.owner.trim() || !connector.repo.trim()) return null;

  const target = getConnectorRepo(project, connector);
  const params = new URLSearchParams();
  params.set("state", filters.state === "closed" ? "closed" : filters.state === "all" ? "all" : "open");
  params.set("per_page", String(filters.limit ?? 30));
  if (filters.labels?.length) params.set("labels", filters.labels.join(","));
  if (filters.assignee) params.set("assignee", filters.assignee);

  const issues = await githubRequest<
    Array<{
      number: number;
      title: string;
      body?: string | null;
      html_url: string;
      state: string;
      state_reason?: string | null;
      labels?: Array<{ name?: string }>;
      assignees?: Array<{ login?: string }>;
      pull_request?: unknown;
    }>
  >(connector, `/repos/${target.owner}/${target.repo}/issues?${params.toString()}`);

  return issues.map(mapGitHubIssue).filter((issue): issue is Issue => issue !== null);
}

export async function updateIssueViaGitHubConnector(
  config: VIConfig,
  projectId: string,
  identifier: string,
  update: IssueUpdate,
): Promise<boolean> {
  const project = config.projects[projectId];
  if (!project) return false;
  const connector = await getSelectedConnector(config, project);
  if (!connector) return false;
  if (!connector.owner.trim() || !connector.repo.trim()) return false;

  const target = getConnectorRepo(project, connector);
  const issueNumber = identifier.replace(/^#/, "");

  if (update.state === "closed" || update.state === "open" || update.labels || update.assignee) {
    await githubRequest<Record<string, unknown>>(
      connector,
      `/repos/${target.owner}/${target.repo}/issues/${issueNumber}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          state:
            update.state === "closed"
              ? "closed"
              : update.state === "open"
                ? "open"
                : undefined,
          labels: update.labels,
          assignees: update.assignee ? [update.assignee] : undefined,
        }),
      },
    );
  }

  if (update.removeLabels?.length) {
    const currentIssues = await listIssuesViaGitHubConnector(config, projectId, {
      state: "all",
      limit: 100,
    });
    const current = currentIssues?.find((issue) => issue.id === issueNumber);
    if (current) {
      const nextLabels = current.labels.filter((label) => !update.removeLabels?.includes(label));
      await githubRequest<Record<string, unknown>>(
        connector,
        `/repos/${target.owner}/${target.repo}/issues/${issueNumber}`,
        {
          method: "PATCH",
          body: JSON.stringify({ labels: nextLabels }),
        },
      );
    }
  }

  if (update.comment) {
    await githubRequest<Record<string, unknown>>(
      connector,
      `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: update.comment }),
      },
    );
  }

  return true;
}

export async function createRepositoryViaGitHubConnector(
  config: VIConfig,
  projectId: string,
  input: {
    owner?: string;
    name: string;
    description?: string;
    visibility?: "public" | "private";
  },
): Promise<{
  name: string;
  fullName: string;
  owner: string;
  url: string;
  visibility: "public" | "private";
} | null> {
  const project = config.projects[projectId];
  if (!project) return null;
  const connector = await getSelectedConnector(config, project);
  if (!connector) return null;

  const owner = (input.owner ?? connector.owner).trim();
  const repoName = input.name.trim();
  if (!owner || !repoName) {
    throw new Error("Both owner and repository name are required");
  }

  const payload = {
    name: repoName,
    description: input.description?.trim() || undefined,
    private: input.visibility !== "public",
    auto_init: false,
  };

  const targetPath =
    owner.toLowerCase() === connector.accountLogin.trim().toLowerCase()
      ? "/user/repos"
      : `/orgs/${owner}/repos`;

  const created = await githubRequest<{
    name: string;
    full_name: string;
    html_url: string;
    private: boolean;
    owner: { login: string };
  }>(connector, targetPath, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  await upsertVIGitHubConnector(config.configPath, project.path, {
    id: connector.id,
    label: connector.label,
    host: connector.host,
    accountLogin: connector.accountLogin,
    owner: created.owner.login,
    repo: created.name,
    accessToken: connector.accessToken,
    authType: connector.authType,
    setAsSelected: true,
  });

  return {
    name: created.name,
    fullName: created.full_name,
    owner: created.owner.login,
    url: created.html_url,
    visibility: created.private ? "private" : "public",
  };
}
