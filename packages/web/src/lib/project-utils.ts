type ProjectWithPrefix = { sessionPrefix?: string };
type SessionLike = { id: string; projectId: string; metadata?: Record<string, string> };

function matchesProject(
  session: SessionLike,
  projectId: string,
  projects: Record<string, ProjectWithPrefix>,
): boolean {
  if (session.projectId === projectId) return true;
  const project = projects[projectId];
  if (project?.sessionPrefix && session.id.startsWith(project.sessionPrefix)) return true;
  return projects[session.projectId]?.sessionPrefix === projectId;
}

export function filterProjectSessions<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): T[] {
  if (!projectFilter || projectFilter === "all") return sessions;
  return sessions.filter((session) => matchesProject(session, projectFilter, projects));
}

export function getProjectScopedHref(
  basePath: "/" | "/sessions",
  projectId: string | undefined,
): string {
  return projectId ? `${basePath}?project=${encodeURIComponent(projectId)}` : `${basePath}?project=all`;
}

// In PI there is no orchestrator meta-session — every session in the store is a worker session.
export function filterWorkerSessions<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): T[] {
  return filterProjectSessions(sessions, projectFilter, projects);
}
