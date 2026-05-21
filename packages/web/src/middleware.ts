import { type NextRequest, NextResponse } from "next/server";

// Always public — no session needed
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/_next/", "/favicon.ico"];

// Machine-to-server calls from vi-agent — no browser cookie
const AGENT_PREFIXES = ["/api/remote-agents/"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    AGENT_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  // No token configured → auth disabled (dev mode)
  const requiredToken = process.env.VI_ACCESS_TOKEN?.trim();
  if (!requiredToken) {
    return NextResponse.next();
  }

  const session = request.cookies.get("pi_session");
  if (session?.value === requiredToken) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") {
    loginUrl.searchParams.set("from", pathname);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
