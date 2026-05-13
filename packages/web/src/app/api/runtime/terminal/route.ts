import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    directTerminalPort: process.env.DIRECT_TERMINAL_PORT ?? null,
    proxyWsPath: process.env.TERMINAL_WS_PATH ?? null,
  });
}
