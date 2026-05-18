import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { isCloudMode } from "@/lib/backend";
import { disableRemoteAgent } from "@/lib/remote-agents";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await props.params;

    if (isCloudMode()) {
      // Disconnect is a local-store concept (marks connectionState=disabled in store.json).
      // In cloud mode the relay drives connection state via heartbeat timeout — there is no
      // manual disable. Use Remove machine or wait for heartbeat timeout instead.
      return jsonWithCorrelation(
        {
          error:
            "Disconnect is not supported in cloud mode. " +
            "Use Remove machine to permanently remove it, or wait for the heartbeat timeout to mark it offline.",
        },
        { status: 409 },
        correlationId,
      );
    }

    const agent = await disableRemoteAgent(id);
    return jsonWithCorrelation({ agent }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to disconnect machine" },
      { status: 500 },
      correlationId,
    );
  }
}
