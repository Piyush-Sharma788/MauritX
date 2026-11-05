/**
 * QA crawl of the running MarutiX web app with Puppeteer (390 px and 1280 px):
 * HTTP status, console errors, hydration warnings, horizontal overflow, broken
 * images, every internal link; plus the main flows end to end (request → tracking,
 * OTP sign-in → donor dashboard, admin grant → 2FA → verify/activate → admin pages).
 *
 *   QA_BASE=http://localhost:3000 QA_DEV_LOG=<dev log path> QA_OUT=<dir> MONGODB_URI=<marutix_qa_* db> \
 *   npx tsx scripts/qa/crawl.ts
 *
 * Synthetic numbers only (+9190000xxxxx). Refuses to run unless MONGODB_URI names a marutix_qa_* database,
 * because it grants an admin role in that database.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { stepAt, totpAt } from "../../src/lib/security/totp";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const DEV_LOG = process.env.QA_DEV_LOG ?? "";
const OUT = process.env.QA_OUT ?? "/tmp/qa-shots";
if (!/\/marutix_qa_[a-z0-9_]+(\?|$)/.test(process.env.MONGODB_URI ?? "")) {
  console.error("Refusing: MONGODB_URI must point at a marutix_qa_* throwaway database.");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = [390, 1280];
const issues: string[] = [];
const issue = (s: string) => {
  issues.push(s);
  console.log(`  ISSUE ${s}`);
};
const visited = new Map<string, number>();
const linkQueue = new Set<string>();
const linkSources = new Map<string, string>();
const results: Record<string, unknown>[] = [];
const state: Record<string, string> = {};

function attach(page: Page, tag: string) {
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || m.type() === "warn" || /hydrat/i.test(t)) {
      if (/Download the React DevTools|\[Fast Refresh\]|\[HMR\]/.test(t)) return;
      issue(`[console ${m.type()}] ${tag} ${page.url().replace(BASE, "")}: ${t.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (e) => issue(`[pageerror] ${tag} ${page.url().replace(BASE, "")}: ${String(e).slice(0, 300)}`));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && !/_rsc=|__nextjs|webpack-hmr|turbopack-hmr/.test(u) && r.failure()?.errorText !== "net::ERR_ABORTED") issue(`[requestfailed] ${tag} ${u.replace(BASE, "")}: ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 500) issue(`[http ${r.status()}] ${tag} ${u.replace(BASE, "")}`);
  });
}

const slug = (p: string) => p.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "home";

async function inspect(page: Page, path: string, tag: string, width: number, shot = true) {
  await page.setViewport({ width, height: 900 });
  const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 90_000 });
  await sleep(400);
  const status = res?.status() ?? 0;
  const finalPath = page.url().replace(BASE, "");
  const info = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    const wide: string[] = [];
    if (overflow > 1) {
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.right > doc.clientWidth + 1 && r.width > 0) {
          wide.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(" ").slice(0, 3).join(".")} right=${Math.round(r.right)}`);
          if (wide.length >= 4) break;
        }
      }
    }
    const brokenImgs = Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.slice(0, 120));
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href);
    const h1 = document.querySelector("h1")?.textContent?.trim().slice(0, 80) ?? "";
    const title = document.title;
    // Text clipped by its own box (overflowing ellipsis-free containers).
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll("h1,h2,h3,button,a,p,span,td,th,label"))) {
      const h = el as HTMLElement;
      const cs = getComputedStyle(h);
      if (h.scrollWidth > h.clientWidth + 2 && (cs.overflow === "hidden" || cs.overflowX === "hidden") && cs.textOverflow !== "ellipsis" && h.clientWidth > 0) {
        clipped.push(`${h.tagName.toLowerCase()} "${h.textContent?.trim().slice(0, 40)}"`);
        if (clipped.length >= 4) break;
      }
    }
    return { overflow, wide, brokenImgs, links, h1, title, clipped };
  });
  const rec = { tag, path, width, status, finalPath, h1: info.h1, title: info.title, overflow: info.overflow };
  results.push(rec);
  console.log(`  ${status} ${width}px ${path}${finalPath !== path ? ` → ${finalPath}` : ""}  [${info.h1}]`);
  if (status >= 400) issue(`HTTP ${status} ${tag} ${path} @${width}`);
  if (info.overflow > 1) issue(`horizontal overflow ${info.overflow}px ${tag} ${path} @${width}: ${info.wide.join(" | ")}`);
  if (info.brokenImgs.length) issue(`broken images ${tag} ${path}: ${info.brokenImgs.join(", ")}`);
  if (info.clipped.length) console.log(`    note: clipped text candidates: ${info.clipped.join(" | ")}`);
  for (const l of info.links) {
    if (!l.startsWith(BASE)) continue;
    const u = l.replace(BASE, "").split("#")[0] || "/";
    if (!linkQueue.has(u)) {
      linkQueue.add(u);
      linkSources.set(u, `${tag} ${path}`);
    }
  }
  if (shot) await page.screenshot({ path: join(OUT, `${tag}-${slug(path)}-${width}.png`), fullPage: true });
  return { status, finalPath };
}

function otpFromLog(e164: string, sinceLen: number): string | null {
  const log = readFileSync(DEV_LOG, "utf8").slice(sinceLen);
  const re = new RegExp(`To:\\s+\\+91 ${e164.slice(3, 5)}XXX XX${e164.slice(-3)}[\\s\\S]*?Code:\\s+(\\d{6})`, "g");
  let m: RegExpExecArray | null;
  let code: string | null = null;
  while ((m = re.exec(log))) code = m[1];
  return code;
}
const logLen = () => readFileSync(DEV_LOG, "utf8").length;

async function clickText(page: Page, selector: string, text: string | RegExp) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = (await h.evaluate((e) => e.textContent ?? "")).trim();
    if (typeof text === "string" ? t.includes(text) : text.test(t)) {
      const visible = await h.evaluate((e) => (e as HTMLElement).offsetParent !== null);
      if (!visible) continue;
      await h.click();
      return true;
    }
  }
  return false;
}
async function fillLabel(page: Page, labelText: string, value: string) {
  const id = await page.evaluate((lt) => {
    const l = Array.from(document.querySelectorAll("label")).find((x) => x.textContent?.trim().startsWith(lt));
    return l?.htmlFor ?? null;
  }, labelText);
  if (!id) throw new Error(`no label ${labelText}`);
  await page.type(`[id="${id}"]`, value);
}

async function signIn(page: Page, e164: string, tag: string) {
  await page.setViewport({ width: 390, height: 900 });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  const before = logLen();
  await page.type('input[name="phone"]', e164.slice(3));
  await clickText(page, "button[type=submit]", /./);
  let code: string | null = null;
  for (let i = 0; i < 40 && !code; i++) {
    await sleep(300);
    code = otpFromLog(e164, before);
  }
  if (!code) {
    const msg = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent ?? "");
    throw new Error(`${tag}: no OTP in log (${msg})`);
  }
  await page.waitForSelector('input[aria-label="Digit 1 of 6"]');
  await page.screenshot({ path: join(OUT, `${tag}-otp-entry-390.png`) });
  await page.type('input[aria-label="Digit 1 of 6"]', code);
  await sleep(500);
  await clickText(page, "button[type=submit]", /./).catch(() => false);
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
  await sleep(1000);
  console.log(`  ${tag} signed in → ${page.url().replace(BASE, "")}`);
  return page.url().replace(BASE, "");
}

async function main() {
  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const run = String(Date.now()).slice(-4);
  const donorPhone = `+919000021${run.slice(0, 3)}`;
  const adminPhone = `+919000031${run.slice(0, 3)}`;
  const contactPhone = `9000041${run}`;
  state.donorPhone = donorPhone;
  state.adminPhone = adminPhone;

  // ---------------- A. anonymous crawl
  console.log("\n=== A. Anonymous pages");
  const anon = await browser.newPage();
  attach(anon, "anon");
  const publicPaths = ["/", "/donate", "/get-help", "/privacy", "/request", "/login", "/track/not-a-real-token-000000000000000000000", "/respond/not-a-real-token-0000000000000000000", "/nonexistent-page-qa"];
  const protectedPaths = ["/dashboard", "/profile/edit", "/admin", "/admin/requests", "/admin/coordination", "/admin/institutions", "/admin/operations", "/admin/whatsapp", "/admin/audit", "/admin/mfa"];
  for (const w of WIDTHS) for (const p of publicPaths) await inspect(anon, p, "anon", w);
  for (const p of protectedPaths) {
    const r = await inspect(anon, p, "anon", 1280, false);
    if (!/^\/login/.test(r.finalPath)) issue(`anonymous ${p} was not redirected to /login (ended at ${r.finalPath}, HTTP ${r.status})`);
  }

  // ---------------- B. request flow
  console.log("\n=== B. Create a request on /request (390 px)");
  const pg = await browser.newPage();
  attach(pg, "req");
  await pg.setViewport({ width: 390, height: 900 });
  await pg.goto(`${BASE}/request`, { waitUntil: "networkidle2" });
  await clickText(pg, "button", "Continue");
  await sleep(300);
  await pg.screenshot({ path: join(OUT, "req-step1-errors-390.png"), fullPage: true });
  await fillLabel(pg, "Patient's name", "Q. A.");
  await fillLabel(pg, "Contact person's name", "Qa Tester");
  await fillLabel(pg, "Contact person's mobile", contactPhone);
  await clickText(pg, "button", "Continue");
  await sleep(300);
  await pg.evaluate(() => (document.querySelector('input[name="bloodGroup"]')?.closest("label") as HTMLElement)?.click());
  // B+ is the third group usually; pick by text
  await pg.evaluate(() => {
    const l = Array.from(document.querySelectorAll('input[name="bloodGroup"]')).map((i) => i.closest("label") as HTMLElement).find((x) => x?.textContent?.trim().startsWith("B+"));
    l?.click();
  });
  await pg.evaluate(() => (document.querySelector('input[name="component"]')?.closest("label") as HTMLElement)?.click());
  await pg.evaluate(() => (document.querySelector('input[name="priority"]')?.closest("label") as HTMLElement)?.click());
  await clickText(pg, "button", "In 6 hours");
  await pg.screenshot({ path: join(OUT, "req-step2-390.png"), fullPage: true });
  await clickText(pg, "button", "Continue");
  await sleep(300);
  await fillLabel(pg, "Hospital name", "QA City Hospital");
  await fillLabel(pg, "Hospital address", "1 Hazratganj Road");
  await fillLabel(pg, "City", "Lucknow");
  await fillLabel(pg, "Locality", "Hazratganj");
  await pg.screenshot({ path: join(OUT, "req-step3-390.png"), fullPage: true });
  await clickText(pg, "button", "Continue");
  await sleep(300);
  const consentId = await pg.evaluate(() => (document.querySelector('input[type="checkbox"]:not(:checked)') as HTMLInputElement | null)?.id ?? null);
  // tick the consent box (the last checkbox on the review step)
  await pg.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const consent = boxes.at(-1);
    if (consent && !consent.checked) consent.click();
  });
  void consentId;
  await pg.screenshot({ path: join(OUT, "req-review-390.png"), fullPage: true });
  await clickText(pg, "button", "Submit request");
  await pg.waitForSelector('input[aria-label="Private tracking link"]', { timeout: 30_000 }).catch(() => issue("request submit: no tracking link shown"));
  await pg.screenshot({ path: join(OUT, "req-success-390.png"), fullPage: true });
  const trackUrl = await pg.evaluate(() => (document.querySelector('input[aria-label="Private tracking link"]') as HTMLInputElement | null)?.value ?? "");
  const reqId = await pg.evaluate(() => /MX-[A-Z0-9]{8}/.exec(document.body.innerText)?.[0] ?? "");
  state.trackUrl = trackUrl;
  state.reqId = reqId;
  console.log(`  created ${reqId}, tracking ${trackUrl ? trackUrl.replace(/[^/]{20,}$/, "<token>") : "(none)"}`);
  if (trackUrl) {
    const trackPath = trackUrl.replace(/^https?:\/\/[^/]+/, "");
    for (const w of WIDTHS) await inspect(pg, trackPath, "track", w);
    const nearby = await pg.evaluate(() => /Nearby blood banks/i.test(document.body.innerText));
    if (!nearby) issue("tracking page has no 'Nearby blood banks & hospitals' section");
  }

  // ---------------- C. donor sign-in
  console.log("\n=== C. OTP sign-in as a new user → donor dashboard");
  const dctx = await browser.createBrowserContext();
  const dp = await dctx.newPage();
  attach(dp, "donor");
  const landed = await signIn(dp, donorPhone, "donor");
  state.donorLanded = landed;
  for (const w of WIDTHS) for (const p of ["/dashboard", "/profile/edit", "/", "/donate"]) await inspect(dp, p, "donor", w);
  // donor tries admin
  for (const p of ["/admin", "/admin/requests", "/admin/whatsapp"]) {
    const r = await inspect(dp, p, "donor", 1280, false);
    if (r.status === 200 && r.finalPath.startsWith("/admin") && !/mfa/.test(r.finalPath)) {
      const text = await dp.evaluate(() => document.body.innerText.slice(0, 200));
      if (!/not|denied|forbidden|permission|404/i.test(text)) issue(`donor can open ${p} (final ${r.finalPath}): ${text.slice(0, 100)}`);
    }
  }
  const donorCookies = await dctx.cookies();
  writeFileSync(join(OUT, "donor-cookie.txt"), donorCookies.map((c) => `${c.name}=${c.value}`).join("; "));

  // ---------------- D. admin
  console.log("\n=== D. Admin: grant, sign in, 2FA, verify/activate, all admin pages");
  const actx = await browser.createBrowserContext();
  const ap = await actx.newPage();
  attach(ap, "admin");
  await signIn(ap, adminPhone, "admin-pre");
  const grant = execFileSync(join(process.cwd(), "node_modules/.bin/tsx"), ["--conditions=react-server", "--env-file=.env.local", "scripts/admin-role.ts", "grant", "super_admin", adminPhone], { encoding: "utf8", env: process.env });
  console.log(`  grant: ${grant.trim().split("\n").at(-1)}`);
  // resend cooldown
  await sleep(31_000);
  const afterAdmin = await signIn(ap, adminPhone, "admin");
  if (!/\/admin\/mfa/.test(afterAdmin)) issue(`admin sign-in did not go to /admin/mfa (went to ${afterAdmin})`);
  await ap.goto(`${BASE}/admin/mfa`, { waitUntil: "networkidle2" });
  await ap.screenshot({ path: join(OUT, "admin-mfa-start-390.png"), fullPage: true });
  await clickText(ap, "button", "Set up authenticator");
  await ap.waitForSelector("details summary", { timeout: 15_000 });
  await ap.click("details summary");
  await sleep(300);
  await ap.screenshot({ path: join(OUT, "admin-mfa-enroll-390.png"), fullPage: true });
  const secret = await ap.evaluate(() => document.querySelector("details p")?.textContent?.replace(/\s+/g, "") ?? "");
  const code = totpAt(secret, stepAt(new Date()));
  await ap.type('input[aria-label="Digit 1 of 6"]', code);
  await sleep(2500);
  await ap.screenshot({ path: join(OUT, "admin-mfa-recovery-390.png"), fullPage: true });
  await ap.evaluate(() => (Array.from(document.querySelectorAll('input[type="checkbox"]')).at(-1) as HTMLInputElement | undefined)?.click());
  await clickText(ap, "button", /Continue/);
  await ap.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
  console.log(`  after 2FA → ${ap.url().replace(BASE, "")}`);

  if (reqId) {
    await ap.setViewport({ width: 1280, height: 900 });
    await ap.goto(`${BASE}/admin/requests/${reqId}`, { waitUntil: "networkidle2" });
    for (const verb of ["Mark verified", "Mark active"]) {
      const ok = await clickText(ap, "button", verb);
      if (!ok) {
        issue(`admin request page: no "${verb}" button`);
        continue;
      }
      await sleep(300);
      await clickText(ap, '[role="alertdialog"] button', "Confirm");
      await sleep(3000);
      const err = await ap.evaluate(() => document.querySelector('[role="alert"]')?.textContent ?? "");
      if (err) issue(`admin ${verb}: ${err}`);
      console.log(`  ${verb} clicked`);
    }
    await sleep(8000);
  }
  const adminPaths = ["/admin", "/admin/requests", reqId ? `/admin/requests/${reqId}` : "", "/admin/coordination", "/admin/institutions", "/admin/operations", "/admin/whatsapp", "/admin/audit", "/admin/requests/MX-ZZZZZZZZ", "/admin/institutions/000000000000000000000000", "/admin/institutions/not-an-id"].filter(Boolean);
  for (const w of WIDTHS) for (const p of adminPaths) await inspect(ap, p, "admin", w);
  // first institution detail if any
  const inst = await ap.evaluate(() => (Array.from(document.querySelectorAll('a[href^="/admin/institutions/"]')) as HTMLAnchorElement[]).map((a) => a.getAttribute("href"))[0] ?? null);
  await ap.goto(`${BASE}/admin/institutions`, { waitUntil: "networkidle2" });
  const inst2 = await ap.evaluate(() => (Array.from(document.querySelectorAll('a[href^="/admin/institutions/"]')) as HTMLAnchorElement[]).map((a) => a.getAttribute("href"))[0] ?? null);
  if (inst || inst2) for (const w of WIDTHS) await inspect(ap, (inst2 ?? inst)!, "admin", w);
  // tracking page after activation
  if (state.trackUrl) {
    const tp = await browser.newPage();
    attach(tp, "track2");
    for (const w of WIDTHS) await inspect(tp, state.trackUrl.replace(/^https?:\/\/[^/]+/, ""), "track-active", w);
  }
  const adminCookies = await actx.cookies();
  writeFileSync(join(OUT, "admin-cookie.txt"), adminCookies.map((c) => `${c.name}=${c.value}`).join("; "));

  // ---------------- E. follow every internal link seen
  console.log("\n=== E. Internal links");
  const lp = await actx.newPage();
  attach(lp, "link");
  for (const u of linkQueue) {
    if (/\/(api)\//.test(u) || u.startsWith("/admin/requests/MX-") || /logout/.test(u)) continue;
    const res = await lp.goto(`${BASE}${u}`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => (issue(`link ${u}: ${e}`), null));
    const s = res?.status() ?? 0;
    visited.set(u, s);
    if (s >= 400) issue(`broken link ${u} (HTTP ${s}) from ${linkSources.get(u)}`);
  }
  console.log(`  followed ${visited.size} links`);

  writeFileSync(join(OUT, "results.json"), JSON.stringify({ state, results, issues, links: Object.fromEntries(visited) }, null, 2));
  console.log(`\n${issues.length} issue(s).`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ state, results, issues, error: String(e) }, null, 2));
  process.exit(1);
});
