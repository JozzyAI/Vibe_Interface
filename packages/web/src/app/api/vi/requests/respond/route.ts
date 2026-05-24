import { type NextRequest } from "next/server";
import {
  respondToVIPendingQuestion,
  upsertVIPendingQuestion,
  type VIRequestKind,
} from "@vi/core";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { appendVIApprovalAuditEvent } from "@/lib/vi-approval-hub";
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

  if (typeof body.response !== "string" || body.response.length > 4000) {
    return jsonWithCorrelation(
      { error: "response must be a string up to 4000 characters" },
      { status: 400 },
      correlationId,
    );
  }

  const action =
    body.action === "approve" || body.action === "reject" || body.action === "reply"
      ? body.action
      : null;
  if (!action) {
    return jsonWithCorrelation(
      { error: "action must be one of approve, reject, reply" },
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

  const response = stripControlChars((body.response as string).trim());
  const requestId = typeof body.requestId === "string" ? body.requestId : `${sessionId}:fallback`;
  const title = typeof body.title === "string" ? body.title : "Dashboard reply";
  const message =
    typeof body.message === "string"
      ? body.message
      : action === "approve"
        ? "Approval requested"
        : "Reply requested";

  const kind: VIRequestKind =
    body.kind === "example_request" ||
    body.kind === "scope_clarification" ||
    body.kind === "plan_approval" ||
    body.kind === "final_approval"
      ? body.kind
      : action === "approve"
        ? "plan_approval"
        : "scope_clarification";

  const outboundMessage =
    action === "approve"
      ? [`VI decision: APPROVED`, `Request: ${title}`, `Why: ${message}`, response]
          .filter(Boolean)
          .join("\n\n")
      : action === "reject"
        ? [`VI decision: REJECTED`, `Request: ${title}`, `Why: ${message}`, response]
            .filter(Boolean)
            .join("\n\n")
        : response;

  await sessionManager.send(sessionId, outboundMessage);

  let updated = await respondToVIPendingQuestion(
    config.configPath,
    project.path,
    sessionId,
    requestId,
    response,
    action,
  );

  if (!updated) {
    updated = await upsertVIPendingQuestion(config.configPath, project.path, sessionId, {
      id: requestId.startsWith("piq_") ? requestId : undefined,
      sessionId,
      kind,
      title,
      message,
      status: action === "approve" ? "approved" : action === "reject" ? "rejected" : "answered",
      response,
    });
  }

  await appendVIApprovalAuditEvent(config.configPath, project.path, {
    actorLabel: "VI dashboard",
    eventType: "approval_response",
    title:
      action === "approve"
        ? "Approval granted"
        : action === "reject"
          ? "Approval rejected"
          : "Agent reply sent",
    details: response || outboundMessage,
    sessionId,
    requestId,
  });

  return jsonWithCorrelation(
    {
      ok: true,
      request: updated,
    },
    { status: 200 },
    correlationId,
  );
}
