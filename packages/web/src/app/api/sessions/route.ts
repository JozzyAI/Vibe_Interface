import { listPISessions, upsertPISession, type PISession } from "@pi/core";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { filterProjectSessions } from "@/lib/project-utils";
import { getDashboardPageData } from "@/lib/dashboard-page-data";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project") ?? undefined;
    const { config } = await getServices();
    const all = await listPISessions();
    const sessions = filterProjectSessions(all, projectFilter, config.projects);
    const pageData = await getDashboardPageData(projectFilter);
    return jsonWithCorrelation(
      { sessions: pageData.sessions, stats: { total: sessions.length } },
      { status: 200 },
      correlationId,
    );
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to list sessions" },
      { status: 500 },
      correlationId,
    );
  }
}

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const body = (await request.json()) as Partial<PISession & { prompt: string }>;
    const { sessionManager } = await getServices();
    const session = await sessionManager.spawn({
      projectId: body.projectId ?? "default",
      prompt: body.prompt ?? body.title,
      issueId: body.issueId,
    });
    return jsonWithCorrelation({ session }, { status: 201 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to create session" },
      { status: 500 },
      correlationId,
    );
  }
}
