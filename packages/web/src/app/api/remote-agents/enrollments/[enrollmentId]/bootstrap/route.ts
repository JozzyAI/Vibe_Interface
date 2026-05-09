import { type NextRequest } from "next/server";
import { getCorrelationId } from "@/lib/observability";
import { getRemoteEnrollmentForBootstrap } from "@/lib/remote-agents";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ enrollmentId: string }> },
) {
  const correlationId = getCorrelationId(request);
  try {
    const { enrollmentId } = await context.params;
    const enrollment = await getRemoteEnrollmentForBootstrap({ enrollmentId });
    const server = request.nextUrl.origin;
    const packageUrl = `${server}/api/remote-agents/bootstrap/package`;
    const script = `#!/usr/bin/env bash
set -euo pipefail

SERVER="${server}"
CODE="${enrollment.code}"
PACKAGE_URL="${packageUrl}"

if ! command -v pi-agent >/dev/null 2>&1; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to install pi-agent."
    exit 1
  fi
  if ! command -v pip3 >/dev/null 2>&1 && ! python3 -m pip --version >/dev/null 2>&1; then
    echo "pip is required to install pi-agent."
    exit 1
  fi
  echo "Installing pi-agent from PI..."
  python3 -m pip install --user "$PACKAGE_URL"
  export PATH="$HOME/.local/bin:$PATH"
fi

exec pi-agent pair --server "$SERVER" --code "$CODE" --start
`;
    return new Response(script, {
      status: 200,
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Content-Disposition": `attachment; filename="pi-connect-${enrollment.code}.sh"`,
        "Cache-Control": "no-store",
        "X-Correlation-Id": correlationId,
      },
    });
  } catch (error) {
    const body = error instanceof Error ? error.message : "Failed to generate bootstrap script";
    return new Response(body, {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Correlation-Id": correlationId,
      },
    });
  }
}
