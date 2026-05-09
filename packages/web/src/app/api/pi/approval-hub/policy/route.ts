import { type NextRequest } from "next/server";
import { getDashboardPageData, resolveDashboardProjectFilter } from "@/lib/dashboard-page-data";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getPIApprovalHubData, setPIApprovalPolicy } from "@/lib/pi-approval-hub";
import { validateIdentifier } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const projectId = resolveDashboardProjectFilter(
    typeof body.projectId === "string" ? body.projectId : undefined,
  );
  if (projectId === "all") {
    return jsonWithCorrelation(
      { error: "Approval Hub policies require a concrete project" },
      { status: 400 },
      correlationId,
    );
  }

  const mode =
    body.mode === "manual" || body.mode === "timeout_allow" || body.mode === "always_allow"
      ? body.mode
      : null;
  if (!mode) {
    return jsonWithCorrelation(
      { error: "mode must be one of manual, timeout_allow, always_allow" },
      { status: 400 },
      correlationId,
    );
  }

  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : undefined;
  if (sessionId) {
    const sessionErr = validateIdentifier(sessionId, "sessionId");
    if (sessionErr) {
      return jsonWithCorrelation({ error: sessionErr }, { status: 400 }, correlationId);
    }
  }

  const timeoutSeconds =
    typeof body.timeoutSeconds === "number" && Number.isFinite(body.timeoutSeconds)
      ? body.timeoutSeconds
      : undefined;

  await setPIApprovalPolicy({
    projectId,
    sessionId,
    mode,
    timeoutSeconds,
  });

  const pageData = await getDashboardPageData(projectId);
  const data = await getPIApprovalHubData({
    projectId,
    sessions: pageData.sessions,
    controlPlane: pageData.controlPlane,
  });

  return jsonWithCorrelation(data, { status: 200 }, correlationId);
}

