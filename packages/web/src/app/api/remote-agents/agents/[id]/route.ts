import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { isCloudMode } from "@/lib/backend";
import { updateRemoteAgentDetails, forgetRemoteAgent, removeRemoteAgent as localRemoveRemoteAgent } from "@/lib/remote-agents";
import { removeRemoteAgent as cloudRemoveRemoteAgent } from "@/lib/relay-cloud-client";

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await props.params;
    const body = (await request.json().catch(() => ({}))) as {
      force?: boolean;
      removeJobs?: boolean;
    };

    if (isCloudMode()) {
      // Cloud mode: relay owns state — always call relay remove (relay has no soft-forget concept).
      const result = await cloudRemoveRemoteAgent({ agentId: id });
      return jsonWithCorrelation({ ...result, removed: true }, { status: 200 }, correlationId);
    }

    // Local mode: preserve soft-forget / force-remove distinction.
    if (body.force) {
      const result = await localRemoveRemoteAgent({ agentId: id, removeJobs: body.removeJobs ?? true });
      return jsonWithCorrelation({ removed: true, ...result }, { status: 200 }, correlationId);
    }
    await forgetRemoteAgent(id);
    return jsonWithCorrelation({ forgotten: true }, { status: 200 }, correlationId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to remove machine";
    // "Unknown remote agent" means the agent is already gone — treat as idempotent success
    // so the UI can refresh and navigate away instead of getting stuck on a stale page.
    if (msg.includes("Unknown remote agent")) {
      return jsonWithCorrelation({ removed: true, alreadyRemoved: true }, { status: 200 }, correlationId);
    }
    const status = msg.includes("active job") ? 409 : 500;
    return jsonWithCorrelation({ error: msg }, { status }, correlationId);
  }
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const params = await props.params;
    const body = (await request.json()) as {
      displayName?: string;
      projectLabel?: string;
    };
    const agent = await updateRemoteAgentDetails({
      agentId: params.id,
      displayName: body.displayName,
      projectLabel: body.projectLabel,
    });
    return jsonWithCorrelation({ agent }, { status: 200 }, correlationId);
  } catch (error) {
    return jsonWithCorrelation(
      { error: error instanceof Error ? error.message : "Failed to update machine" },
      { status: 500 },
      correlationId,
    );
  }
}
