import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/auth/permissions";

/**
 * Route-guard inventory. Every Route Handler under src/app/api must be listed
 * here with the guard each HTTP method uses. A new route (or a changed guard)
 * fails this test until it is classified on purpose.
 *
 * Guards:
 * - admin:<permission>  requireAdmin(permission): session + staff role + MFA + permission
 * - user                requireUser() / getCurrentUser() with a 401
 * - tracking            X-Tracking-Token header (256-bit), rate-limited per IP, scoped to the request
 * - outreach            X-Outreach-Token header (256-bit), rate-limited per IP
 * - webhook             HMAC signature (POST) / verify token (GET)
 * - public              intentionally open (each listed with a reason below)
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const API_DIR = path.join(ROOT, "src/app/api");
const ADMIN_PAGES_DIR = path.join(ROOT, "src/app/admin");

type Guard = `admin:${(typeof PERMISSIONS)[number]}` | "user" | "tracking" | "outreach" | "webhook" | "public";

const EXPECTED: Record<string, Record<string, Guard>> = {
  // Aliases of the v1 routes (same handlers).
  "auth/logout": { POST: "public" },
  "auth/send-otp": { POST: "public" },
  "auth/verify-otp": { POST: "public" },
  "whatsapp/connect": { POST: "admin:whatsapp.manage" },
  "whatsapp/logout": { POST: "admin:whatsapp.manage" },
  "whatsapp/qr": { GET: "admin:whatsapp.manage" },
  "whatsapp/send-message": { POST: "admin:whatsapp.manage" },
  "whatsapp/status": { GET: "admin:whatsapp.read" },

  health: { GET: "public" },

  "v1/auth/logout": { POST: "public" },
  "v1/auth/me": { GET: "user" },
  "v1/auth/otp/request": { POST: "public" },
  "v1/auth/otp/verify": { POST: "public" },
  // Second factor: any signed-in user; the service refuses non-staff accounts.
  "v1/auth/mfa/enroll": { POST: "user" },
  "v1/auth/mfa/enroll/confirm": { POST: "user" },
  "v1/auth/mfa/verify": { POST: "user" },

  "v1/account/deletion": { POST: "user" },
  "v1/account/deletion/otp": { POST: "user" },
  "v1/donors/me": { GET: "user", PATCH: "user" },
  "v1/donors/me/availability": { PATCH: "user" },
  "v1/donors/me/consents": { POST: "user" },
  "v1/donors/me/notifications": { GET: "user" },
  "v1/donors/me/phone/otp": { POST: "user" },
  "v1/donors/me/phone/verify": { POST: "user" },

  "v1/requests": { POST: "public" },
  "v1/requests/[publicRequestId]": { GET: "tracking" },
  "v1/requests/[publicRequestId]/cancel": { POST: "tracking" },
  "v1/requests/[publicRequestId]/status": { POST: "tracking" },
  "v1/requests/[publicRequestId]/share-links": { POST: "tracking" },
  "v1/requests/[publicRequestId]/share-links/[linkId]": { DELETE: "tracking" },
  "v1/requests/[publicRequestId]/contact-links": { POST: "tracking" },
  "v1/requests/[publicRequestId]/donors/[responseId]/reveal": { POST: "tracking" },
  "v1/requests/[publicRequestId]/donors/[responseId]/contacted": { POST: "tracking" },

  "v1/outreach/respond": { POST: "outreach" },
  "v1/outreach/unsubscribe": { POST: "outreach" },

  "v1/webhooks/whatsapp": { GET: "webhook", POST: "webhook" },

  "v1/admin/audit": { GET: "admin:audit.read" },
  "v1/admin/conversations": { GET: "admin:conversations.read" },
  "v1/admin/coordination": { GET: "admin:admin.access" },
  "v1/admin/institutions": { GET: "admin:admin.access", POST: "admin:institutions.review" },
  "v1/admin/institutions/discovery": { GET: "admin:admin.access", POST: "admin:institutions.review" },
  "v1/admin/institutions/[institutionId]": { GET: "admin:admin.access" },
  "v1/admin/institutions/[institutionId]/review": { POST: "admin:institutions.review" },
  "v1/admin/institutions/[institutionId]/status": { POST: "admin:institutions.verify" },
  "v1/admin/institutions/[institutionId]/channels": { POST: "admin:institutions.review" },
  "v1/admin/institutions/[institutionId]/channels/[channelId]": { PATCH: "admin:institutions.review" },
  "v1/admin/institutions/[institutionId]/channels/[channelId]/status": { POST: "admin:institutions.review" },
  "v1/admin/institutions/[institutionId]/contacts": { POST: "admin:institutions.verify" },
  "v1/admin/institutions/[institutionId]/contacts/[contactId]": { POST: "admin:institutions.verify" },
  "v1/admin/jobs": { GET: "admin:operations.read" },
  "v1/admin/jobs/[jobId]/retry": { POST: "admin:jobs.retry" },
  "v1/admin/messages/[messageId]/retry": { POST: "admin:messages.retry" },
  "v1/admin/operations": { GET: "admin:operations.read" },
  "v1/admin/operations/failed-messages": { GET: "admin:operations.read" },
  "v1/admin/operations/settings": { PATCH: "admin:operations.settings" },
  "v1/admin/requests": { GET: "admin:requests.manage" },
  "v1/admin/requests/[publicRequestId]": { GET: "admin:requests.manage" },
  "v1/admin/requests/[publicRequestId]/status": { POST: "admin:requests.manage" },
  "v1/admin/requests/[publicRequestId]/share-links/[linkId]": { DELETE: "admin:requests.manage" },
  "v1/admin/requests/[publicRequestId]/alerts": { POST: "admin:coordination.manage" },
  "v1/admin/requests/[publicRequestId]/automation": { POST: "admin:coordination.manage" },
  "v1/admin/requests/[publicRequestId]/coordination": { GET: "admin:coordination.manage" },
  "v1/admin/requests/[publicRequestId]/institution": { POST: "admin:coordination.manage" },
  "v1/admin/requests/[publicRequestId]/matching": { POST: "admin:coordination.manage" },
  "v1/admin/requests/[publicRequestId]/outreach/[outreachId]": { POST: "admin:coordination.manage" },
  "v1/admin/requests/[publicRequestId]/responses/[responseId]/status": { POST: "admin:coordination.manage" },
  "v1/admin/whatsapp/connect": { POST: "admin:whatsapp.manage" },
  "v1/admin/whatsapp/logout": { POST: "admin:whatsapp.manage" },
  "v1/admin/whatsapp/messages": { GET: "admin:whatsapp.read" },
  "v1/admin/whatsapp/qr": { GET: "admin:whatsapp.manage" },
  "v1/admin/whatsapp/send-message": { POST: "admin:whatsapp.manage" },
  "v1/admin/whatsapp/status": { GET: "admin:whatsapp.read" },
};

/** Why each public route is open, and where its abuse limit lives. */
const PUBLIC_REASONS: Record<string, { reason: string; rateLimitedIn?: [file: string, fn: string][] }> = {
  "auth/logout": { reason: "alias of v1/auth/logout" },
  "auth/send-otp": { reason: "alias of v1/auth/otp/request", rateLimitedIn: [["src/server/services/otp.ts", "requestOtp"]] },
  "auth/verify-otp": { reason: "alias of v1/auth/otp/verify", rateLimitedIn: [["src/server/services/otp.ts", "verifyOtp"]] },
  health: { reason: "container healthcheck; reveals only up/down" },
  "v1/auth/logout": { reason: "revokes only the caller's own cookie session; idempotent" },
  "v1/auth/otp/request": { reason: "sign-in", rateLimitedIn: [["src/server/services/otp.ts", "requestOtp"]] },
  "v1/auth/otp/verify": { reason: "sign-in", rateLimitedIn: [["src/server/services/otp.ts", "verifyOtp"]] },
  "v1/requests": { reason: "emergency request without an account", rateLimitedIn: [["src/server/requests/service.ts", "createRequest"]] },
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

const routeKey = (file: string) => path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
const read = (file: string) => readFileSync(file, "utf8");

/** Follows `export { POST } from "@/app/api/.../route"` aliases to the real handler file. */
function resolveSource(file: string): string {
  const alias = read(file).match(/export\s*\{[^}]*\}\s*from\s*"@\/app\/api\/([^"]+)\/route"/);
  return alias ? resolveSource(path.join(API_DIR, alias[1], "route.ts")) : file;
}

/** The exported HTTP methods and the source text of each handler. */
function handlers(source: string): Record<string, string> {
  const re = /export\s+(?:const\s+(GET|POST|PUT|PATCH|DELETE)\s*=|async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\()/g;
  const found: { method: string; start: number }[] = [];
  for (const m of source.matchAll(re)) found.push({ method: m[1] ?? m[2], start: m.index });
  return Object.fromEntries(found.map((f, i) => [f.method, source.slice(f.start, found[i + 1]?.start ?? source.length)]));
}

function guardOf(segment: string): Guard {
  const admin = [...segment.matchAll(/requireAdmin\(\s*"([\w.]+)"\s*\)/g)];
  if (admin.length > 1) throw new Error("More than one requireAdmin call in a handler");
  if (admin.length === 1) return `admin:${admin[0][1]}` as Guard;
  if (/requireAdmin\(\s*\)/.test(segment)) throw new Error("requireAdmin() must name its permission explicitly");
  if (/requireUser\(\)/.test(segment)) return "user";
  if (/getCurrentUser\(\)/.test(segment) && /UNAUTHENTICATED/.test(segment)) return "user";
  if (/readTrackingToken\(/.test(segment)) return "tracking";
  if (/readOutreachToken\(/.test(segment)) return "outreach";
  if (/verifySignature\(|verifySubscription\(/.test(segment)) return "webhook";
  return "public";
}

/** The body of an exported function, roughly: from its declaration to the next top-level export. */
function functionBody(file: string, fn: string): string {
  const text = read(path.join(ROOT, file));
  const start = text.search(new RegExp(`export async function ${fn}\\b`));
  if (start < 0) throw new Error(`${fn} not found in ${file}`);
  const next = text.indexOf("\nexport ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

const files = routeFiles(API_DIR);
const inventory = files.map((file) => {
  const source = resolveSource(file);
  const text = read(source);
  const methods = handlers(text);
  return { key: routeKey(file), file, source, text, methods };
});

describe("API route-guard inventory", () => {
  it("lists every route handler, and nothing that no longer exists", () => {
    expect(inventory.map((r) => r.key).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(inventory.map((r) => [r.key, r] as const))("%s uses the expected guard per method", (key, route) => {
    const actual = Object.fromEntries(Object.entries(route.methods).map(([m, seg]) => [m, guardOf(seg)]));
    expect(actual).toEqual(EXPECTED[key]);
  });

  it("guards run before any other work (first statement after the handler opens)", () => {
    for (const route of inventory) {
      for (const [method, seg] of Object.entries(route.methods)) {
        const guard = EXPECTED[route.key][method];
        if (!guard.startsWith("admin:") && guard !== "user") continue;
        // The first awaited call inside the handler must be the guard.
        const firstAwait = seg.match(/await\s+([\w.]+)\(/)?.[1];
        expect([`${route.key} ${method}`, firstAwait]).toEqual([`${route.key} ${method}`, guard === "user" ? expect.stringMatching(/^(requireUser|getCurrentUser)$/) : "requireAdmin"]);
      }
    }
  });

  it("every public route has a documented reason, and the sign-in/creation ones are rate-limited", () => {
    const publicKeys = inventory.filter((r) => Object.values(EXPECTED[r.key]).includes("public")).map((r) => r.key).sort();
    expect(publicKeys).toEqual(Object.keys(PUBLIC_REASONS).sort());
    for (const { rateLimitedIn = [] } of Object.values(PUBLIC_REASONS)) {
      for (const [file, fn] of rateLimitedIn) expect(functionBody(file, fn), `${file} ${fn}`).toMatch(/enforceRateLimit\(/);
    }
  });

  it("tracking and outreach tokens are rate-limited before they are checked", () => {
    expect(functionBody("src/server/requests/http.ts", "readTrackingToken")).toMatch(/enforceRateLimit\([\s\S]*TRACKING_TOKEN\.test/);
    expect(functionBody("src/server/outreach/http.ts", "readOutreachToken")).toMatch(/enforceRateLimit\([\s\S]*TRACKING_TOKEN\.test/);
  });

  it("every route except the health check and the signed webhook goes through apiRoute (CSRF check, safe errors)", () => {
    for (const route of inventory) {
      if (route.key === "health" || route.key === "v1/webhooks/whatsapp") continue;
      for (const [method, seg] of Object.entries(route.methods)) expect(seg, `${route.key} ${method}`).toMatch(/=\s*apiRoute\(/);
    }
  });

  it("never turns the origin check off for a state-changing method", () => {
    for (const route of inventory) {
      for (const [method, seg] of Object.entries(route.methods)) {
        if (method !== "GET") expect(seg, `${route.key} ${method}`).not.toMatch(/checkOrigin:\s*false/);
      }
    }
  });

  it("reads bodies only through the size-limited, schema-validated parser", () => {
    for (const route of inventory) {
      if (route.key === "v1/webhooks/whatsapp") continue; // raw bytes are needed for the HMAC; it caps its own size
      expect(route.text, route.key).not.toMatch(/request\.(json|text|formData|arrayBuffer|blob)\(/);
    }
  });

  it("validates dynamic route segments (no raw param reaches a query unchecked)", () => {
    for (const route of inventory) {
      if (!route.key.includes("[")) continue;
      // Either the shared validator, or the service is handed the raw string and validates it (ObjectId.isValid / schema).
      if (route.key.includes("[publicRequestId]")) expect(route.text, route.key).toMatch(/readPublicRequestId\(route\)/);
    }
  });
});

describe("admin pages", () => {
  const pages = collect(ADMIN_PAGES_DIR);
  function collect(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return collect(full);
      return name === "page.tsx" ? [full] : [];
    });
  }

  it("every admin page is gated by requireAdminPage, except the MFA step and the index redirect", () => {
    for (const page of pages) {
      const rel = path.relative(ADMIN_PAGES_DIR, page).split(path.sep).join("/");
      const text = read(page);
      if (rel === "page.tsx") {
        expect(text).toMatch(/redirect\("\/admin\/operations"\)/);
        expect(text).not.toMatch(/from "@\/server\//);
      } else if (rel === "mfa/page.tsx") {
        expect(text).toMatch(/if \(!user\) redirect\("\/login"\)/);
        expect(text).toMatch(/if \(!isStaffRole\(user\.role\)\) notFound\(\)/);
      } else {
        expect(text, rel).toMatch(/await requireAdminPage\("[\w.]+"\)/);
      }
    }
    expect(pages.length).toBeGreaterThan(5);
  });
});

describe("client bundle hygiene", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }
  const all = sources(path.join(ROOT, "src"));

  it("no client component imports server-only modules", () => {
    const serverModules = /from\s+"@\/(server\/|lib\/(env|logger|db\/|security\/(crypto|config-check)|auth\/(current-user|require-)|api\/handler))/;
    for (const file of all) {
      const text = read(file);
      if (/^\s*["']use client["']/.test(text)) expect(text, path.relative(ROOT, file)).not.toMatch(serverModules);
    }
  });

  it("server modules holding secrets are marked server-only", () => {
    for (const rel of ["src/lib/env.ts", "src/lib/security/crypto.ts", "src/lib/logger.ts", "src/lib/api/handler.ts", "src/lib/auth/current-user.ts", "src/server/services/session.ts", "src/server/services/otp.ts"]) {
      expect(read(path.join(ROOT, rel)), rel).toMatch(/^import "server-only";/m);
    }
  });

  it("no NEXT_PUBLIC_ variables and no raw HTML injection", () => {
    for (const file of all) {
      const text = read(file);
      expect(text, path.relative(ROOT, file)).not.toMatch(/NEXT_PUBLIC_|dangerouslySetInnerHTML|\.innerHTML\s*=/);
    }
  });

  it("there are no Server Actions (every mutation goes through a CSRF-checked API route)", () => {
    for (const file of all) expect(read(file), path.relative(ROOT, file)).not.toMatch(/^\s*["']use server["']/m);
  });
});

/* Runtime: call each protected handler with no session and from a foreign origin. No database is needed for these paths. */
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const BASE = "http://localhost:3000";
const sample: Record<string, string> = {
  publicRequestId: "MX-ABCD-1234",
  linkId: "0123456789abcdef01234567",
  responseId: "0123456789abcdef01234567",
  institutionId: "0123456789abcdef01234567",
  channelId: "0123456789abcdef01234567",
  contactId: "0123456789abcdef01234567",
  jobId: "0123456789abcdef01234567",
  messageId: "0123456789abcdef01234567",
  outreachId: "0123456789abcdef01234567",
};
const paramsFor = (key: string) => Object.fromEntries([...key.matchAll(/\[(\w+)\]/g)].map(([, name]) => [name, sample[name]]));

type Handler = (req: NextRequest, route: { params: Promise<Record<string, string>> }) => Promise<Response>;

describe("protected handlers at runtime", () => {
  const protectedRoutes = inventory.filter((r) => Object.values(EXPECTED[r.key]).some((g) => g === "user" || g.startsWith("admin:")));

  it.each(protectedRoutes.map((r) => [r.key, r] as const))("%s refuses a request without a session (401)", async (key, route) => {
    const mod = (await import(route.file)) as Record<string, Handler>;
    for (const method of Object.keys(EXPECTED[key])) {
      const body = method === "GET" || method === "DELETE" ? undefined : "{}";
      const req = new NextRequest(`${BASE}/api/${key}`, { method, headers: { origin: BASE, ...(body ? { "content-type": "application/json" } : {}) }, body });
      const res = await mod[method](req, { params: Promise.resolve(paramsFor(key)) });
      expect([key, method, res.status]).toEqual([key, method, 401]);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    }
  });

  const mutations = inventory.flatMap((r) => (r.key === "v1/webhooks/whatsapp" || r.key === "health" ? [] : Object.keys(r.methods).filter((m) => m !== "GET").map((m) => [`${r.key} ${m}`, r, m] as const)));

  it.each(mutations)("%s rejects a cross-site request before doing anything (403)", async (_label, route, method) => {
    const mod = (await import(route.file)) as Record<string, Handler>;
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }] as Record<string, string>[]) {
      const req = new NextRequest(`${BASE}/api/${route.key}`, { method, headers: { ...headers, "content-type": "application/json" }, body: "{}" });
      const res = await mod[method](req, { params: Promise.resolve(paramsFor(route.key)) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN_ORIGIN");
    }
  });

  it("covers every method in the inventory", () => {
    for (const r of inventory) expect(Object.keys(r.methods).every((m) => (METHODS as readonly string[]).includes(m))).toBe(true);
  });
});
