import { listPISessions, derivePISessionState } from "@pi/core";
import { getAttentionLevel } from "@/lib/types";
import { filterProjectSessions } from "@/lib/project-utils";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectFilter = searchParams.get("project") ?? undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const { config } = await getServices();
        const all = await listPISessions();
        const sessions = filterProjectSessions(all, projectFilter, config.projects);

        const snapshot = {
          type: "snapshot" as const,
          emittedAt: new Date().toISOString(),
          sessions: sessions.map((s) => ({
            id: s.id,
            status: s.status,
            activity: s.activity,
            attentionLevel: getAttentionLevel({
              id: s.id,
              projectId: s.projectId,
              status: s.status,
              piState: derivePISessionState(s),
              activity: s.activity,
              branch: s.branch ?? null,
              issueId: s.issueId ?? null,
              issueUrl: null,
              issueLabel: null,
              issueTitle: s.title ?? null,
              userPrompt: s.metadata["userPrompt"] ?? null,
              summary: s.agentInfo?.summary ?? s.lastUpdate ?? null,
              summaryIsFallback: !s.agentInfo?.summary,
              createdAt: s.createdAt,
              lastActivityAt: s.updatedAt,
              pr: null,
              metadata: s.metadata,
            }),
            lastActivityAt: s.updatedAt,
          })),
        };

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
      } catch {
        void 0;
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
