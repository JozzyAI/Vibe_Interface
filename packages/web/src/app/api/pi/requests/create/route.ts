import { type NextRequest } from "next/server";
import { upsertPIPendingQuestion } from "@pi/core";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { appendPIApprovalAuditEvent, getPIApprovalPolicy } from "@/lib/pi-approval-hub";
import { stripControlChars, validateIdentifier } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const sessionErr = validateIdentifier(body.sessionId, "sessionId");
  if (sessionErr) {
    return jsonWithCorrelation({ error: sessionErr }, { status: 400 }, correlationId);
  }

  const kind =
    body.kind === "example_request" ||
    body.kind === "scope_clarification" ||
    body.kind === "plan_approval" ||
    body.kind === "final_approval"
      ? body.kind
      : null;
  if (!kind) {
    return jsonWithCorrelation(
      { error: "kind must be one of example_request, scope_clarification, plan_approval, final_approval" },
      { status: 400 },
      correlationId,
    );
  }

  if (typeof body.title !== "string" || body.title.trim().length === 0 || body.title.length > 240) {
    return jsonWithCorrelation(
      { error: "title must be a non-empty string up to 240 characters" },
      { status: 400 },
      correlationId,
    );
  }

  if (typeof body.message !== "string" || body.message.trim().length === 0 || body.message.length > 4000) {
    return jsonWithCorrelation(
      { error: "message must be a non-empty string up to 4000 characters" },
      { status: 400 },
      correlationId,
    );
  }

  const { config, sessionManager } = await getServices();
  const sessionId = body.sessionId as string;
  const session = await sessionManager.get(sessionId);
  if (!session) {
    return jsonWithCorrelation({ error: `Session not found: ${sessionId}` }, { status: 404 }, correlationId);
  }

  const project = config.projects[session.projectId];
  if (!project) {
    return jsonWithCorrelation(
      { error: `Project not found for session ${sessionId}` },
      { status: 404 },
      correlationId,
    );
  }

  const title = stripControlChars((body.title as string).trim());
  const message = stripControlChars((body.message as string).trim());
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  const actorLabel =
    typeof body.actorLabel === "string" && body.actorLabel.trim().length > 0
      ? stripControlChars(body.actorLabel.trim())
      : session.metadata["agent"] ?? "session";

  const policy = await getPIApprovalPolicy({
    projectId: session.projectId,
    sessionId,
  });

  const shouldAutoApprove = policy.mode === "always_allow";

  const pending = await upsertPIPendingQuestion(config.configPath, project.path, sessionId, {
    id: requestId,
    sessionId,
    kind,
    title,
    message,
    status: shouldAutoApprove ? "approved" : "open",
    response: shouldAutoApprove ? `Auto-approved by PI policy (${policy.mode})` : undefined,
  });

  await appendPIApprovalAuditEvent(config.configPath, project.path, {
    actorLabel,
    eventType: "request_created",
    title,
    details: shouldAutoApprove
      ? `${message}\n\nAuto-approved because policy mode is ${policy.mode}.`
      : message,
    sessionId,
    requestId: pending.id,
  });

  return jsonWithCorrelation(
    {
      ok: true,
      request: pending,
      policy,
      action: shouldAutoApprove ? "approved" : "queued",
    },
    { status: 200 },
    correlationId,
  );
}

