import { type NextRequest } from "next/server";
import { getDashboardPageData, resolveDashboardProjectFilter } from "@/lib/dashboard-page-data";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getVIApprovalHubData } from "@/lib/vi-approval-hub";

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const projectId = resolveDashboardProjectFilter(request.nextUrl.searchParams.get("project") ?? undefined);

  if (projectId === "all") {
    return jsonWithCorrelation(
      { error: "Approval Hub requires a concrete project scope" },
      { status: 400 },
      correlationId,
    );
  }

  const pageData = await getDashboardPageData(projectId);
  const data = await getVIApprovalHubData({
    projectId,
    sessions: pageData.sessions,
    controlPlane: pageData.controlPlane,
  });

  return jsonWithCorrelation(data, { status: 200 }, correlationId);
}

