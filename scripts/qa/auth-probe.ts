/**
 * QA black-box probe of sign-in protections against a running MarutiX web app
 * (throwaway marutix_qa_* database only): OTP brute force, OTP request rate limits,
 * X-Forwarded-For spoofing, and a staff session that hasn't completed 2FA.
 *
 *   QA_BASE=http://localhost:3000 QA_DEV_LOG=<dev log> MONGODB_URI=<marutix_qa_* db> npx tsx scripts/qa/auth-probe.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const DEV_LOG = process.env.QA_DEV_LOG ?? "";
if (!/\/marutix_qa_[a-z0-9_]+(\?|$)/.test(process.env.MONGODB_URI ?? "")) {
  console.error("Refusing: MONGODB_URI must point at a marutix_qa_* throwaway database.");
  process.exit(2);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logLen = () => readFileSync(DEV_LOG, "utf8").length;
function codeFor(e164: string, since: number) {
  const re = new RegExp(`To:\\s+\\+91 ${e164.slice(3, 5)}XXX XX${e164.slice(-3)}[\\s\\S]*?Code:\\s+(\\d{6})`, "g");
  const log = readFileSync(DEV_LOG, "utf8").slice(since);
  let m: RegExpExecArray | null;
  let c: string | null = null;
  while ((m = re.exec(log))) c = m[1];
  return c;
}

class Client {
  cookies = new Map<string, string>();
  constructor(private xff?: string) {}
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { origin: BASE, "content-type": "application/json", cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...extra };
    if (this.xff) headers["x-forwarded-for"] = this.xff;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json: { data?: Record<string, unknown> | null; error?: { code?: string; message?: string; details?: Record<string, unknown> } | null } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* */
    }
    return { status: res.status, json, text };
  }
}

const stamp = String(Date.now()).slice(-3);
const num = (n: number) => `+9190000${String(6 + (n % 4))}${String(n).padStart(1, "0")}${stamp}`.slice(0, 13);

async function main() {
  console.log("=== 1. OTP brute force on one number");
  const victim = `+91900007${stamp}1`.slice(0, 13);
  const c = new Client();
  const since = logLen();
  let r = await c.call("POST", "/api/v1/auth/otp/request", { phone: victim });
  console.log(`  request → ${r.status} ${r.json?.error?.code ?? ""}`);
  await sleep(1500);
  const real = codeFor(victim, since);
  console.log(`  dev code captured: ${real ? "yes" : "no"}`);
  const statuses: string[] = [];
  for (let i = 0; i < 12; i++) {
    let wrong = String((Number(real ?? "0") + 1 + i) % 1_000_000).padStart(6, "0");
    if (wrong === real) wrong = "000000";
    r = await c.call("POST", "/api/v1/auth/otp/verify", { phone: victim, code: wrong });
    statuses.push(`${r.status}:${r.json?.error?.code ?? "ok"}`);
  }
  console.log(`  12 wrong codes → ${statuses.join(" ")}`);
  r = await c.call("POST", "/api/v1/auth/otp/verify", { phone: victim, code: real });
  console.log(`  then the CORRECT code → ${r.status} ${r.json?.error?.code ?? "ok"} ${r.json?.error?.message ?? ""}`);
  if (r.status === 200) console.log("  ISSUE: correct code still accepted after 12 wrong attempts");

  console.log("\n=== 2. OTP requests for many numbers from one client (IP limit)");
  const per: string[] = [];
  for (let i = 0; i < 15; i++) {
    r = await new Client().call("POST", "/api/v1/auth/otp/request", { phone: `+9190000${String(80 + i).padStart(2, "0")}${stamp}` });
    per.push(`${r.status}${r.json?.error?.code ? `:${r.json.error.code}` : ""}`);
  }
  console.log(`  15 numbers → ${per.join(" ")}`);
  const firstLimited = per.findIndex((s) => s.startsWith("429"));
  console.log(`  first 429 at #${firstLimited + 1}`);

  console.log("\n=== 3. Same, rotating X-Forwarded-For (spoofing a different client IP each time)");
  const spoof: string[] = [];
  for (let i = 0; i < 10; i++) {
    r = await new Client(`203.0.113.${10 + i}`).call("POST", "/api/v1/auth/otp/request", { phone: `+9190000${String(60 + i).padStart(2, "0")}${stamp}` });
    spoof.push(`${r.status}${r.json?.error?.code ? `:${r.json.error.code}` : ""}`);
  }
  console.log(`  10 numbers with spoofed XFF → ${spoof.join(" ")}`);
  if (spoof.filter((s) => s.startsWith("200")).length > 0 && firstLimited >= 0) console.log("  ISSUE: X-Forwarded-For from the client resets the per-IP OTP limit (no proxy in front: TRUSTED_PROXY_HOPS default trusts the client's header)");

  console.log("\n=== 4. Resend cooldown on one number");
  const cd = new Client("198.51.100.7");
  const p4 = `+91900009${stamp}2`.slice(0, 13);
  const a = await cd.call("POST", "/api/v1/auth/otp/request", { phone: p4 });
  const b = await cd.call("POST", "/api/v1/auth/otp/request", { phone: p4 });
  console.log(`  two requests → ${a.status}, ${b.status} ${JSON.stringify(b.json?.error?.details ?? {})}`);

  console.log("\n=== 5. Staff role but 2FA not completed");
  const staff = `+91900008${stamp}3`.slice(0, 13);
  const s = new Client("198.51.100.8");
  let since2 = logLen();
  await s.call("POST", "/api/v1/auth/otp/request", { phone: staff });
  await sleep(1500);
  let v = await s.call("POST", "/api/v1/auth/otp/verify", { phone: staff, code: codeFor(staff, since2) });
  console.log(`  first sign-in → ${v.status}`);
  const out = execFileSync(join(process.cwd(), "node_modules/.bin/tsx"), ["--conditions=react-server", "--env-file=.env.local", "scripts/admin-role.ts", "grant", "super_admin", staff], { encoding: "utf8", env: process.env });
  console.log(`  grant: ${out.trim().split("\n").at(-1)}`);
  const old = await s.call("GET", "/api/v1/admin/requests");
  console.log(`  pre-grant session after grant → GET /api/v1/admin/requests ${old.status} (expect 401: sessions revoked)`);
  await sleep(31_000);
  since2 = logLen();
  await s.call("POST", "/api/v1/auth/otp/request", { phone: staff });
  await sleep(1500);
  v = await s.call("POST", "/api/v1/auth/otp/verify", { phone: staff, code: codeFor(staff, since2) });
  console.log(`  staff sign-in → ${v.status} redirectTo=${v.json?.data?.redirectTo}`);
  for (const [m, p, body] of [
    ["GET", "/api/v1/admin/requests", undefined],
    ["GET", "/api/v1/admin/operations", undefined],
    ["GET", "/api/v1/admin/audit", undefined],
    ["POST", "/api/v1/admin/whatsapp/connect", {}],
    ["POST", "/api/v1/auth/mfa/verify", { code: "123456" }],
  ] as const) {
    const x = await s.call(m, p, body);
    console.log(`  no-2FA ${m} ${p} → ${x.status} ${x.json?.error?.code ?? ""}`);
  }
  const mfaBrute: string[] = [];
  for (let i = 0; i < 8; i++) {
    const x = await s.call("POST", "/api/v1/auth/mfa/enroll/confirm", { code: String(100000 + i) });
    mfaBrute.push(`${x.status}${x.json?.error?.code ? `:${x.json.error.code}` : ""}`);
  }
  console.log(`  8 wrong enrolment codes → ${mfaBrute.join(" ")} (enroll not started: expect errors)`);
  const en = await s.call("POST", "/api/v1/auth/mfa/enroll");
  console.log(`  enroll → ${en.status}`);
  for (let i = 0; i < 8; i++) {
    const x = await s.call("POST", "/api/v1/auth/mfa/enroll/confirm", { code: String(200000 + i) });
    mfaBrute.push(`${x.status}${x.json?.error?.code ? `:${x.json.error.code}` : ""}`);
  }
  console.log(`  8 wrong confirm codes after enrol → ${mfaBrute.slice(8).join(" ")}`);
  console.log(`\nsynthetic numbers used: victim ${victim}, staff ${staff}, cooldown ${p4}, bulk +9190000{60..69,80..94}${stamp}`);
  void num;
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
