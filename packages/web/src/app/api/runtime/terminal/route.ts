import { NextResponse } from "next/server";

export async function GET() {
  const relayBase = (process.env["PI_RELAY_BASE_URL"] ?? "").trim();
  const piToken = (process.env["PI_RELAY_PI_TOKEN"] ?? "").trim();
  const cloudMode = !!(relayBase && piToken);

  let relayHost: string | null = null;
  if (cloudMode && relayBase) {
    try {
      relayHost = new URL(relayBase).hostname;
    } catch {
      relayHost = relayBase;
    }
  }

  return NextResponse.json({
    directTerminalPort: process.env.DIRECT_TERMINAL_PORT ?? null,
    proxyWsPath: process.env.TERMINAL_WS_PATH ?? null,
    mode: cloudMode ? "cloud" : "local",
    relayHost,
  });
}
