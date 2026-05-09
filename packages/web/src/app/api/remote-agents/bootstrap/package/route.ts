import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { getCorrelationId } from "@/lib/observability";
import type { NextRequest } from "next/server";

const execFileAsync = promisify(execFile);

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const repoRoot = join(process.cwd(), "..", "..");
    const bridgesDir = join(repoRoot, "bridges");
    const { stdout } = await execFileAsync(
      "tar",
      ["-czf", "-", "-C", bridgesDir, "pi-remote-bridge"],
      {
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    return new Response(new Uint8Array(stdout as Buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="pi-remote-bridge.tar.gz"',
        "Cache-Control": "no-store",
        "X-Correlation-Id": correlationId,
      },
    });
  } catch (error) {
    const body = error instanceof Error ? error.message : "Failed to package pi-remote-bridge";
    return new Response(body, {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Correlation-Id": correlationId,
      },
    });
  }
}
