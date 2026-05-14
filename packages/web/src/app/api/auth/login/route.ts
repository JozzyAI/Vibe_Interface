import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function POST(request: NextRequest) {
  const { token } = (await request.json()) as { token?: string };
  const required = process.env.PI_ACCESS_TOKEN?.trim();

  if (!required) {
    // Auth not configured — open access
    return NextResponse.json({ ok: true });
  }

  if (!token?.trim() || token.trim() !== required) {
    return NextResponse.json({ error: "Invalid access token" }, { status: 401 });
  }

  const jar = await cookies();
  jar.set("pi_session", required, {
    httpOnly: true,
    secure: false, // HTTP on LAN; flip to true when HTTPS relay lands
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return NextResponse.json({ ok: true });
}
