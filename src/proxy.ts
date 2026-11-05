import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gate for admin pages: without any session cookie, redirect to
 * sign-in before rendering, so not even the static admin shell is served.
 * This is not the access check: every admin page and API still calls
 * requireAdminPage / requireAdmin (session, staff role, second factor,
 * permission) against the database.
 *
 * Kept free of server modules on purpose (Proxy must not depend on render
 * code); the cookie names mirror sessionCookieName() and a test keeps them in step.
 */
export const SESSION_COOKIE_NAMES = ["__Host-marutix_session", "marutix_session"] as const;

export function proxy(request: NextRequest) {
  const name = process.env.NODE_ENV === "production" ? SESSION_COOKIE_NAMES[0] : SESSION_COOKIE_NAMES[1];
  if (request.cookies.get(name)?.value) return NextResponse.next();
  const response = NextResponse.redirect(new URL("/login", request.url), 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
