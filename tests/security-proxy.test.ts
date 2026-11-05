import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy, SESSION_COOKIE_NAMES } from "@/proxy";
import { sessionCookieName, sessionCookieOptions } from "@/server/services/session";

/** The optimistic admin gate in src/proxy.ts, and the session cookie attributes. */
describe("admin proxy gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("only runs on admin pages", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
  });

  it.each(["development", "production"] as const)("uses the same cookie name as the session service (%s)", (env) => {
    vi.stubEnv("NODE_ENV", env);
    const expected = sessionCookieName();
    expect(SESSION_COOKIE_NAMES).toContain(expected);
    const withCookie = new NextRequest("http://localhost:3000/admin/operations", { headers: { cookie: `${expected}=abc` } });
    expect(proxy(withCookie).headers.get("location")).toBeNull();
  });

  it("redirects to sign-in, uncached, when there is no session cookie", () => {
    const res = proxy(new NextRequest("http://localhost:3000/admin/requests/MX-ABCD-1234"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("in production ignores a cookie without the __Host- prefix", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = proxy(new NextRequest("http://localhost:3000/admin", { headers: { cookie: "marutix_session=abc" } }));
    expect(res.status).toBe(307);
  });
});

describe("session cookie", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is HttpOnly, SameSite=Lax, host-only, path /, and Secure with the __Host- prefix in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const opts = sessionCookieOptions(new Date(Date.now() + 1000));
    expect(sessionCookieName()).toBe("__Host-marutix_session");
    expect(opts).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(opts).not.toHaveProperty("domain");
  });

  it("drops Secure only for plain-http development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookieName()).toBe("marutix_session");
    expect(sessionCookieOptions(new Date()).secure).toBe(false);
  });
});
