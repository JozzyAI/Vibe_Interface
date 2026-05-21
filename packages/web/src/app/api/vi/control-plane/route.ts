import { type NextRequest } from "next/server";
import { getVIControlPlaneData } from "@/lib/vi-control-plane";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("project") ?? undefined;
    const data = await getVIControlPlaneData(projectId);
    return jsonWithCorrelation(data, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to load PI control plane" },
      { status: 500 },
      correlationId,
    );
  }
}
