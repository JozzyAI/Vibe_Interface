import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export function getCorrelationId(request?: Request): string {
  const header = request instanceof Request
    ? request.headers.get("x-correlation-id")
    : null;
  return header ?? randomUUID();
}

export function jsonWithCorrelation(
  data: unknown,
  init?: ResponseInit,
  correlationId?: string,
): NextResponse {
  const response = NextResponse.json(data, init);
  if (correlationId) {
    response.headers.set("x-correlation-id", correlationId);
  }
  return response;
}

// Stub — observability not yet implemented
export function recordApiObservation(_input: unknown): void {
  void 0;
}

export function resolveProjectIdForSessionId(
  _sessionId: string,
  _projects: Record<string, unknown>,
): string | undefined {
  return undefined;
}
