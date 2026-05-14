import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET(request: NextRequest) {
  const jar = await cookies();
  jar.delete("pi_session");
  const origin = new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/login`);
}
