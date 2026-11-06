/**
 * End-to-end check of the WhatsApp bot through a REAL running MarutiX stack.
 *
 *   npm run test:e2e
 *
 * Starts its own isolated environment with scripts/dev.mjs (the same launcher as `npm run dev`):
 * Next.js web app, jobs worker and WhatsApp worker on separate ports, against a throwaway
 * database (marutix_e2e_<random>) that is dropped at the end. Stop `npm run dev` first.
 *
 * What is real: HTTP, webhook signature checks, the conversation engine, MongoDB, the jobs
 * worker (coordination waves, matching), the outbox and its consent checks, web OTP sign-in,
 * admin 2FA and the admin API. In phase 2, outbound calls go to Meta's real Graph API.
 *
 * What is simulated: the inbound WhatsApp messages. They are delivered exactly as Meta would
 * deliver them (signed POSTs to /api/v1/webhooks/whatsapp), but they come from this script and
 * synthetic phone numbers, not from real phones.
 *
 * Safety: no real person can be messaged. In phase 1 replies wait in the outbox of an unpaired
 * WhatsApp Web session; in phase 2 the Cloud API token is deliberately invalid, so Meta refuses
 * every send. Both are asserted.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ----------------------------------------------------------------- isolated configuration
const ROOT = process.cwd();
const RUN = randomBytes(3).toString("hex");
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3999);
const BASE = `http://localhost:${WEB_PORT}`;
// Outside the project folder: next dev treats writes inside it as code changes.
const SESSION_DIR = join(tmpdir(), `marutix-e2e-whatsapp-session-${RUN}`);
const APP_SECRET = randomBytes(24).toString("hex");
const VERIFY_TOKEN = randomBytes(16).toString("hex");
const PHONE_NUMBER_ID = "100000000000001";
const baseMongo = (process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/marutix").replace(/\/([^/?]*)(\?|$)/, `/marutix_e2e_${RUN}$2`);

const isolated: Record<string, string> = {
  MONGODB_URI: baseMongo,
  APP_BASE_URL: BASE,
  PORT: String(WEB_PORT),
  WHATSAPP_WEB_WORKER_URL: `http://127.0.0.1:${Number(process.env.E2E_WORKER_PORT ?? 3199)}`,
  WHATSAPP_WEB_SESSION_DIR: SESSION_DIR,
  WHATSAPP_WEB_TEST_RECIPIENTS: "",
  OTP_PROVIDER: "development",
  // Inbound arrives through the Cloud API webhook. The token is deliberately not a real one.
  WHATSAPP_ACCESS_TOKEN: "E2E_INVALID_TOKEN_never_valid_at_meta",
  WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  WHATSAPP_OTP_TEMPLATE_NAME: "",
  // Keep the run fast and deterministic.
  COORDINATION_AUTOSTART: "true",
  DONOR_WAVE_INTERVAL_MINUTES: "20",
  DISCOVERY_PROVIDER: "none",
  EMAIL_PROVIDER: "none",
  ERROR_ALERT_WEBHOOK_URL: "",
  NO_COLOR: "1",
};
Object.assign(process.env, isolated, { MESSAGING_PROVIDER: "whatsapp_web" });

// ----------------------------------------------------------------- reporting
type Result = { phase: string; name: string; ok: boolean; detail?: string };
const results: Result[] = [];
let phase = "";
const transcriptOn = !process.argv.includes("--quiet");
function check(name: string, ok: boolean, detail?: string) {
  results.push({ phase, name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const section = (title: string) => {
  phase = title;
  console.log(`\n=== ${title}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- MongoDB for the whole run
/**
 * If no local MongoDB is running, start one for the duration of the run. (If the stack started
 * it, stopping the stack would stop MongoDB before the throwaway database could be dropped.)
 */
let ownMongo: ChildProcess | null = null;
const mongoUp = (port: number) =>
  new Promise<boolean>((done) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.setTimeout(700, () => (sock.destroy(), done(false)));
    sock.once("connect", () => (sock.destroy(), done(true)));
    sock.once("error", () => done(false));
  });
async function ensureMongo() {
  const m = /^mongodb:\/\/(?:[^@/]*@)?(127\.0\.0\.1|localhost)(?::(\d+))?\//.exec(baseMongo);
  if (!m) return; // remote database: nothing to start
  const port = Number(m[2] ?? 27017);
  if (await mongoUp(port)) return;
  // The same data folder as npm run dev (scripts/dev.mjs).
  const dataDir = process.env.MARUTIX_DATA_DIR?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".marutix");
  const dbPath = join(dataDir, "mongodb");
  mkdirSync(dbPath, { recursive: true, mode: 0o700 });
  ownMongo = spawn("mongod", ["--dbpath", dbPath, "--bind_ip", "127.0.0.1", "--port", String(port), "--quiet", "--logpath", join(dataDir, "mongod.log"), "--logappend"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !(await mongoUp(port)); i++) await sleep(300);
}
async function stopOwnMongo() {
  if (!ownMongo || ownMongo.exitCode !== null) return;
  const exited = new Promise((r) => ownMongo!.once("exit", r));
  ownMongo.kill("SIGTERM");
  await Promise.race([exited, sleep(15_000)]);
}

// ----------------------------------------------------------------- the stack under test
let stack: ChildProcess | null = null;
let stackLog = "";

async function startStack(provider: "whatsapp_web" | "whatsapp_cloud") {
  stackLog = "";
  stack = spawn(process.execPath, ["scripts/dev.mjs"], { cwd: ROOT, env: { ...process.env, ...isolated, MESSAGING_PROVIDER: provider }, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (chunk: Buffer) => {
    stackLog += chunk.toString();
    if (process.env.E2E_VERBOSE) process.stdout.write(chunk);
  };
  stack.stdout!.on("data", collect);
  stack.stderr!.on("data", collect);
  const exited = new Promise<number>((r) => stack!.once("exit", (code) => r(code ?? 1)));
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (/MarutiX is running\./.test(stackLog)) return;
    if (/MarutiX started with problems/.test(stackLog)) throw new Error(`The stack started with problems:\n${stackLog.slice(-3000)}`);
    const done = await Promise.race([exited, sleep(500).then(() => null)]);
    if (done !== null) throw new Error(`The stack exited during startup:\n${stackLog.slice(-3000)}`);
  }
  throw new Error(`The stack didn't become healthy in 4 minutes:\n${stackLog.slice(-3000)}`);
}

/** Waits until the stack's combined log matches. */
async function logShows(re: RegExp, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !re.test(stackLog)) await sleep(250);
  return re.test(stackLog);
}

async function stopStack() {
  if (!stack || stack.exitCode !== null) return;
  const exited = new Promise((r) => stack!.once("exit", r));
  stack.kill("SIGINT");
  await Promise.race([exited, sleep(20_000)]);
  stack = null;
}

// ----------------------------------------------------------------- Meta-shaped webhooks
const sign = (body: string) => `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;

function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "E2E_WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "910000000000", phone_number_id: PHONE_NUMBER_ID }, ...value } }] }],
  };
}

async function postWebhook(payload: unknown, signature?: string | null) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = signature === undefined ? sign(body) : signature;
  if (sig) headers["x-hub-signature-256"] = sig;
  return fetch(`${BASE}/api/v1/webhooks/whatsapp`, { method: "POST", headers, body });
}

// ----------------------------------------------------------------- app modules (loaded after env is set)
type Mods = Awaited<ReturnType<typeof loadModules>>;
async function loadModules() {
  const mongoose = (await import("mongoose")).default;
  const { connectToDatabase } = await import("@/lib/db/mongoose");
  const { decryptPii, phoneLookupToken } = await import("@/lib/security/crypto");
  const { totpAt, stepAt } = await import("@/lib/security/totp");
  const { NotificationEvent } = await import("@/server/models/notification-event");
  const { User } = await import("@/server/models/user");
  const { DonorProfile } = await import("@/server/models/donor-profile");
  const { EmergencyRequest } = await import("@/server/models/emergency-request");
  const { RequestResponse } = await import("@/server/models/request-response");
  const { MessagingOptOut } = await import("@/server/models/messaging-opt-out");
  const { WhatsAppConversation } = await import("@/server/models/whatsapp-conversation");
  return { mongoose, connectToDatabase, decryptPii, phoneLookupToken, totpAt, stepAt, NotificationEvent, User, DonorProfile, EmergencyRequest, RequestResponse, MessagingOptOut, WhatsAppConversation };
}

// ----------------------------------------------------------------- a simulated WhatsApp user
class Phone {
  private seen = new Set<string>();
  constructor(
    readonly label: string,
    readonly e164: string,
    private readonly m: Mods,
  ) {}
  get digits() {
    return this.e164.slice(1);
  }
  get lookup() {
    return this.m.phoneLookupToken(this.e164);
  }

  /** Sends one message the way Meta delivers it and returns the bot's new replies (text of every queued outbox message). */
  async send(input: string | { latitude: number; longitude: number }, id = `wamid.E2E${randomUUID().replace(/-/g, "")}`): Promise<string[]> {
    const message =
      typeof input === "string"
        ? { from: this.digits, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: input } }
        : { from: this.digits, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "location", location: input };
    if (transcriptOn) console.log(`      ${this.label} → ${typeof input === "string" ? JSON.stringify(input) : `[location ${input.latitude}, ${input.longitude}]`}`);
    const res = await postWebhook(envelope({ contacts: [{ wa_id: this.digits, profile: { name: this.label } }], messages: [message] }));
    if (res.status !== 200) throw new Error(`webhook answered ${res.status} for ${this.label}`);
    return this.newReplies();
  }

  /** Sends a raw Meta message object (e.g. a voice note) and returns the bot's new replies. */
  async sendRaw(message: Record<string, unknown>): Promise<string[]> {
    const id = `wamid.E2E${randomUUID().replace(/-/g, "")}`;
    if (transcriptOn) console.log(`      ${this.label} → [${String(message.type)}]`);
    const res = await postWebhook(envelope({ contacts: [{ wa_id: this.digits, profile: { name: this.label } }], messages: [{ from: this.digits, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] }));
    if (res.status !== 200) throw new Error(`webhook answered ${res.status} for ${this.label}`);
    return this.newReplies();
  }

  /** Everything queued for this number since the last call, oldest first. */
  async newReplies(): Promise<string[]> {
    const events = await this.m.NotificationEvent.find({ recipientLookup: this.lookup }).sort({ createdAt: 1, _id: 1 }).lean();
    const out: string[] = [];
    for (const e of events) {
      const key = String(e._id);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const body = e.bodyEncrypted ? this.m.decryptPii(e.bodyEncrypted) : `[${e.kind}: ${e.status}${e.failureCode ? ` ${e.failureCode}` : ""}]`;
      out.push(body);
      if (transcriptOn) console.log(body.split("\n").map((l, i) => `      ${i ? " ".repeat(this.label.length + 2) : `${this.label} ←`} ${l}`).join("\n"));
    }
    return out;
  }

  /** Waits for new replies produced by background work (jobs worker), up to `ms`. */
  async waitForReplies(match: RegExp, ms: number): Promise<string[]> {
    const deadline = Date.now() + ms;
    const collected: string[] = [];
    while (Date.now() < deadline) {
      collected.push(...(await this.newReplies()));
      if (collected.some((r) => match.test(r))) return collected;
      await sleep(1_000);
    }
    return collected;
  }
}

const syntheticPhone = (prefix: string) => `+91${prefix}${String(Math.floor(Math.random() * 10 ** (10 - prefix.length))).padStart(10 - prefix.length, "0")}`;
const has = (replies: string[], re: RegExp) => replies.some((r) => re.test(r));
const last = (replies: string[]) => replies.at(-1) ?? "";

// ----------------------------------------------------------------- web session (OTP + admin 2FA) over HTTP
/** The API envelope: { data, error: { code, message, details }, meta }. Loosely typed on purpose. */
interface ApiJson {
  data?: { channel?: string; redirectTo?: string; secret?: string } | null;
  error?: { code?: string; details?: { retryAfterSeconds?: number } } | null;
  channel?: string;
}

class Browser {
  cookies = new Map<string, string>();
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { origin: BASE, "content-type": "application/json", cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json: json as ApiJson | null };
  }
}

async function signIn(browser: Browser, e164: string) {
  const before = stackLog.length;
  let req = await browser.call("POST", "/api/v1/auth/otp/request", { phone: e164 });
  const wait = Number(req.json?.error?.details?.retryAfterSeconds ?? 0);
  if (req.status === 429 && wait > 0 && wait <= 60) {
    // The resend cooldown is a deliberate protection; wait it out like a person would.
    console.log(`      (resend cooldown: waiting ${wait}s)`);
    await sleep((wait + 1) * 1000);
    req = await browser.call("POST", "/api/v1/auth/otp/request", { phone: e164 });
  }
  if (req.status !== 200) return { ok: false, detail: `otp/request ${req.status} ${JSON.stringify(req.json)}` };
  let code: string | null = null;
  for (let i = 0; i < 20 && !code; i++) {
    const fresh = stackLog.slice(before);
    const m = new RegExp(`To:\\s+\\+91 ${e164.slice(3, 5)}XXX XX${e164.slice(-3)}[\\s\\S]*?Code:\\s+(\\d{6})`).exec(fresh);
    code = m?.[1] ?? null;
    if (!code) await sleep(250);
  }
  if (!code) return { ok: false, detail: "no development code in the web log" };
  const ver = await browser.call("POST", "/api/v1/auth/otp/verify", { phone: e164, code });
  return { ok: ver.status === 200, detail: `channel=${req.json?.data?.channel ?? req.json?.channel ?? "?"}, verify ${ver.status}`, redirectTo: ver.json?.data?.redirectTo };
}

function runTsx(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["--conditions=react-server", "--env-file=.env", ...args], { cwd: ROOT, env: { ...process.env, ...isolated } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

// ----------------------------------------------------------------- phase 1: full bot workflow
async function phaseOne(m: Mods) {
  section("1. Webhook endpoint (real HTTP, Meta's verification and signing rules)");
  const hs = await fetch(`${BASE}/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=e2e_challenge_42`);
  check("GET handshake with the right verify token echoes hub.challenge", hs.status === 200 && (await hs.text()) === "e2e_challenge_42");
  const hsBad = await fetch(`${BASE}/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token-0000000&hub.challenge=x`);
  check("GET handshake with a wrong verify token is refused", hsBad.status === 403, `HTTP ${hsBad.status}`);
  const unsigned = await postWebhook(envelope({ messages: [] }), null);
  check("unsigned POST is rejected", unsigned.status === 401, `HTTP ${unsigned.status}`);
  const forged = await postWebhook(envelope({ messages: [] }), `sha256=${"0".repeat(64)}`);
  check("POST with a forged signature is rejected", forged.status === 401, `HTTP ${forged.status}`);
  const other = await postWebhook({ object: "whatsapp_business_account", entry: [{ id: "x", changes: [{ field: "messages", value: { metadata: { phone_number_id: "999999999" }, messages: [] } }] }] });
  check("signed events for another phone number are acknowledged and ignored", other.status === 200);

  section("2. Donor registration on WhatsApp (onboarding conversation)");
  const donor = new Phone("Donor", syntheticPhone("90000"), m);
  let r = await donor.send("Hi");
  check("an unknown number gets the welcome menu for patients and donors", has(r, /How can we help\? Reply with a number:[\s\S]*1\. I need blood for a patient[\s\S]*2\. I want to become a donor[\s\S]*3\. Track my request[\s\S]*4\. Help/));
  check("the welcome includes the safety lines (112, STOP)", has(r, /call 112/) && has(r, /Reply STOP anytime/));
  const welcomeImage = await m.NotificationEvent.findOne({ recipientLookup: donor.lookup, mediaKey: "welcome" }).lean();
  check("the first reply carries the welcome image (queued once per number)", Boolean(welcomeImage && welcomeImage.idempotencyKey.startsWith("welcome_image:")));
  for (const [answer, expect] of [
    ["2", /name/i],
    ["Asha Verma", /blood group/i],
    ["B+", /city/i],
    ["Prayagraj", /locality|area/i],
    ["Civil Lines", /location/i],
  ] as const) {
    r = await donor.send(answer);
    check(`after "${answer}" the bot asks the next question`, expect.test(last(r)), last(r).split("\n")[0].slice(0, 70));
  }
  r = await donor.send({ latitude: 25.4358, longitude: 81.8463 });
  check("a shared WhatsApp location is accepted", /last donat/i.test(last(r)));
  r = await donor.send("skip");
  check("last donation can be skipped", /available/i.test(last(r)));
  r = await donor.send("1");
  check("availability answered; the bot asks for alert consent", /alert/i.test(last(r)));
  r = await donor.send("yes");
  check("consent given; the bot shows a summary to confirm", /check your details/i.test(last(r)));
  r = await donor.send("YES");
  check("confirmation completes registration", /You're registered, Asha/.test(last(r)));
  const donorUser = await m.User.findOne({ phoneLookup: donor.lookup }).lean();
  const profile = donorUser ? await m.DonorProfile.findOne({ userId: donorUser._id }).lean() : null;
  check("the donor profile is in MongoDB with consent and an approximate location", Boolean(profile?.notificationConsentAt && profile.location && profile.bloodGroup === "B+" && profile.registeredVia === "whatsapp"));

  section("3. Donor commands, duplicate delivery, invalid input");
  r = await donor.send("PROFILE");
  check("PROFILE shows the donor's details", /Blood group: B\+/.test(last(r)));
  r = await donor.send("STATUS");
  check("STATUS shows availability and alerts", /Emergency alerts: On/.test(last(r)));
  r = await donor.send("PAUSE");
  check("PAUSE pauses alerts", has(r, /paus/i));
  r = await donor.send("RESUME");
  check("RESUME turns alerts back on", has(r, /back on|resum|on again|active/i));
  const dupId = `wamid.E2EDUP${RUN}`;
  await donor.send("STATUS", dupId);
  r = await donor.send("STATUS", dupId);
  check("a redelivered message ID (Meta retry) gets no second reply", r.length === 0);
  const fresh = new Phone("Stranger", syntheticPhone("90001"), m);
  r = await fresh.send("asdfgh qwerty");
  check("unrecognised first text gets the welcome menu", has(r, /Reply with a number/));
  r = await fresh.send("zzzz");
  check("an unclear menu reply re-shows the menu with a hint", has(r, /didn't get that[\s\S]*Reply with a number/));
  r = await fresh.send("4");
  check("menu option 4 shows the help text", has(r, /MarutiX coordinates emergency blood requests/));
  r = await fresh.sendRaw({ type: "audio", audio: { id: "E2E_AUDIO", mime_type: "audio/ogg" } });
  check("a voice note gets a polite one-line text-only reply", r.length === 1 && /only read text messages and shared locations/.test(r[0]));
  r = await fresh.sendRaw({ type: "sticker", sticker: { id: "E2E_STICKER" } });
  check("a second unsupported message the same day gets no further reply", r.length === 0);
  r = await fresh.send("MENU");
  check("MENU brings the menu back", has(r, /MarutiX menu\. Reply with a number/));

  section("4. Emergency request on WhatsApp (intent detection from free text)");
  const patient = new Phone("Family", syntheticPhone("90002"), m);
  r = await patient.send("Need B positive blood urgently in Prayagraj");
  check("free text is understood as an emergency request", has(r, /emergency blood request/i), `AI_PROVIDER=${process.env.AI_PROVIDER || "none"}`);
  check("blood group and city were taken from the message", !has(r, /blood group\?/i));
  // Answer whatever the bot asks, like a person would; the most specific prompts come first.
  const answerFor: [RegExp, string][] = [
    [/patient's name/i, "R. K."],
    [/age/i, "skip"],
    [/your name/i, "Sunil Kumar"],
    [/blood group/i, "B+"],
    [/component/i, "1"],
    [/how many units/i, "1"],
    [/how urgent/i, "1"],
    [/(needed|required) by|by when|what time/i, "in 6 hours"],
    [/address/i, "12 MG Road"],
    [/locality|area/i, "Civil Lines"],
    [/which city|city\?/i, "Prayagraj"],
    [/hospital/i, "City Hospital"],
    [/SKIP/, "skip"],
  ];
  for (let turn = 0; turn < 15 && !/Reply YES/i.test(last(r)); turn++) {
    const answer = answerFor.find(([re]) => re.test(last(r)))?.[1];
    if (!answer) break;
    r = await patient.send(answer);
  }
  check("the bot summarises the request before saving", /Blood group: B\+/.test(last(r)) && /YES/.test(last(r)), last(r).split("\n")[0].slice(0, 70));
  check("nothing is saved before the family confirms", (await m.EmergencyRequest.countDocuments({ requesterPhoneLookup: patient.lookup })) === 0);
  r = await patient.send("YES");
  const request = await m.EmergencyRequest.findOne({ requesterPhoneLookup: patient.lookup }).lean();
  // Requests go live on creation (no manual verification step).
  check("YES saves the request and it goes live", request?.status === "active" && request.createdVia === "whatsapp");
  check("the family receives the request ID and a tracking link", Boolean(request && has(r, new RegExp(request.publicRequestId))) && has(r, /\/track\//));
  r = await patient.send("TRACK");
  check("TRACK reports the status", has(r, new RegExp(`${request?.publicRequestId ?? "MX-"}: Active`)));
  r = await patient.send("mera request kaha tak pahucha");
  check("Hinglish free text is understood as TRACK", has(r, new RegExp(`${request?.publicRequestId ?? "MX-"}: Active`)));
  if (!request) throw new Error("Request wasn't created; can't continue the workflow");

  section("5. Web sign-in (OTP) and admin verification over the real API");
  const adminPhone = syntheticPhone("90003");
  const browser = new Browser();
  let s = await signIn(browser, adminPhone);
  check("OTP sign-in through /api/v1/auth/otp/request + verify", s.ok, s.detail);
  const grant = await runTsx(["scripts/admin-role.ts", "grant", "super_admin", adminPhone]);
  check("npm run admin:grant gives the account the super_admin role", grant.code === 0, grant.out.trim().split("\n").at(-1)?.slice(0, 80));
  s = await signIn(browser, adminPhone);
  check("staff sign-in is sent to 2FA", s.ok && s.redirectTo === "/admin/mfa", s.detail);
  const enroll = await browser.call("POST", "/api/v1/auth/mfa/enroll");
  const secret = enroll.json?.data?.secret as string | undefined;
  check("authenticator enrolment returns a TOTP secret", enroll.status === 200 && Boolean(secret));
  const confirm = await browser.call("POST", "/api/v1/auth/mfa/enroll/confirm", { code: m.totpAt(secret!, m.stepAt(new Date())) });
  check("a correct authenticator code completes 2FA", confirm.status === 200, `HTTP ${confirm.status}`);
  const noAuth = await new Browser().call("POST", `/api/v1/admin/requests/${request.publicRequestId}/status`, { status: "verified" });
  check("the admin API refuses an anonymous caller", noAuth.status === 401, `HTTP ${noAuth.status}`);
  // The request is already live, so the admin API must refuse to move it back to "verified".
  const verify = await browser.call("POST", `/api/v1/admin/requests/${request.publicRequestId}/status`, { status: "verified", note: "E2E: confirmed with the hospital" });
  check("the admin API refuses to re-verify a request that is already live", verify.status === 409 && verify.json?.error?.code === "INVALID_TRANSITION", `HTTP ${verify.status}`);

  section("6. Automated matching and donor alert (jobs worker, real background processing)");
  const alert = await donor.waitForReplies(/URGENT BLOOD REQUEST/, 90_000);
  check("the jobs worker matched the donor and queued an alert within 90 s", has(alert, /URGENT BLOOD REQUEST/));
  check("the alert has the request ID and reply options, and no patient name", has(alert, new RegExp(request.publicRequestId)) && has(alert, /1 — I am interested/) && !has(alert, /R\. K\.|Sunil/));
  const familyUpdates = await patient.waitForReplies(/./, 3_000);
  if (familyUpdates.length) check("the family is kept informed as coordination starts", true, `${familyUpdates.length} update(s)`);
  const fresh2 = await m.EmergencyRequest.findById(request._id).lean();
  check("coordination is running with a recorded donor wave", fresh2?.automation?.status === "running" && (fresh2.automation.waves?.length ?? 0) >= 1);

  section("7. Delivery receipts for the alert (status webhooks)");
  // The one simulated step: a paired phone would now send the held alert and WhatsApp would return
  // a message ID. We record that send exactly as the dispatcher does (status sent, body erased).
  // Donors can only answer alerts that were actually delivered, so replies need this.
  const wamid = `wamid.E2EALERT${RUN}`;
  const marked = await m.NotificationEvent.updateOne(
    { recipientLookup: donor.lookup, kind: "emergency_request", status: "queued" },
    { $set: { status: "sent", providerMessageId: wamid, sentAt: new Date() }, $unset: { bodyEncrypted: 1, templateParamsEncrypted: 1, lockedUntil: 1 } },
  );
  console.log("      (simulated: the alert is handed to WhatsApp, which returns a message ID)");
  check("the held alert is recorded as sent (simulated send)", marked.modifiedCount === 1);
  const statusOf = async () => (await m.NotificationEvent.findOne({ providerMessageId: wamid }).lean())?.status;
  const receipt = (status: string, extra: Record<string, unknown> = {}) =>
    postWebhook(envelope({ statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: donor.digits, ...extra }] }));
  await receipt("delivered");
  check("a 'delivered' receipt from the webhook marks the alert delivered", (await statusOf()) === "delivered");
  await receipt("read");
  check("a 'read' receipt marks it read", (await statusOf()) === "read");
  await receipt("delivered");
  check("a late 'delivered' receipt never moves it backwards", (await statusOf()) === "read");
  await receipt("failed", { errors: [{ code: 131026 }] });
  check("a 'failed' receipt after 'read' doesn't overwrite it", (await statusOf()) === "read");

  section("8. Donor responds to the alert");
  r = await donor.send("4");
  check("4 (MORE INFO) returns the hospital details", has(r, /City Hospital/));
  r = await donor.send("1");
  check("1 asks for consent before sharing the donor's contact", has(r, /May we share/i));
  r = await donor.send("yes");
  check("YES records interest and gives next steps", has(r, /Next steps/i));
  const resp = await m.RequestResponse.findOne({ requestId: request._id }).lean();
  check("the response is stored with contact-sharing consent", resp?.response === "interested" && Boolean(resp.contactSharingConsentAt));
  const familyAfter = await patient.waitForReplies(/donor/i, 10_000);
  check("the family is told a donor responded", has(familyAfter, /donor/i));
  r = await donor.send("INTERESTED");
  check("a second INTERESTED is recognised, not double-counted", has(r, /already/i) && (await m.RequestResponse.countDocuments({ requestId: request._id })) === 1);

  section("9. STOP / consent");
  r = await donor.send("STOP");
  check("STOP confirms the opt-out", r.length === 1 && /stop|won't|will not|unsubscribed/i.test(r[0]));
  check("the opt-out is recorded", (await m.MessagingOptOut.countDocuments({ phoneLookup: donor.lookup })) === 1);
  const prof2 = await m.DonorProfile.findOne({ userId: donorUser!._id }).lean();
  check("donor alert consent is withdrawn", prof2?.notificationConsentWithdrawnAt instanceof Date);
  r = await donor.send("hello");
  check("after STOP the bot stays silent", r.length === 0);
  const queuedAfterStop = await m.NotificationEvent.countDocuments({ recipientLookup: donor.lookup, status: "queued", kind: { $ne: "opt_out_confirmation" } });
  check("messages queued for the donor before STOP are suppressed", queuedAfterStop === 0, `${queuedAfterStop} still queued`);
  r = await donor.send("START");
  check("START re-subscribes and the bot answers again", r.length > 0 && (await m.MessagingOptOut.countDocuments({ phoneLookup: donor.lookup })) === 0);

  section("10. Safety");
  const unknown = await postWebhook(envelope({ statuses: [{ id: "wamid.E2E_UNKNOWN", status: "delivered", timestamp: "1", recipient_id: donor.digits }] }));
  check("a status for an unknown message is acknowledged (no retry storm)", unknown.status === 200);
  const reallySent = await m.NotificationEvent.countDocuments({ status: { $in: ["sent", "delivered", "read"] }, providerMessageId: { $ne: wamid } });
  check("nothing was sent to any real number (only the one simulated alert is marked sent)", reallySent === 0, `${reallySent} other sent`);
}

// ----------------------------------------------------------------- phase 2: outbound through Meta's real Graph API
async function phaseTwo(m: Mods) {
  section("11. Cloud API outbound (real HTTPS call to graph.facebook.com, deliberately invalid token)");
  const person = new Phone("CloudUser", syntheticPhone("90004"), m);
  await person.send("HELP");
  const deadline = Date.now() + 45_000;
  type Event = { status: string; attempts: number; failureCode?: string };
  let event: Event | null = null;
  while (Date.now() < deadline) {
    event = (await m.NotificationEvent.findOne({ recipientLookup: person.lookup }).sort({ createdAt: -1 }).lean()) as Event | null;
    if (event && ["failed", "sent"].includes(event.status)) break;
    await sleep(1_000);
  }
  check("the jobs worker picked the reply from the outbox and called the Cloud API", Boolean(event && event.attempts >= 1), event ? `status=${event.status} attempts=${event.attempts}` : "no event");
  check("Meta refused the invalid token and the message failed permanently (no retries, no fake success)", event?.status === "failed" && event.failureCode === "REJECTED", `failureCode=${event?.failureCode}`);
  check("first contact: the welcome image upload was tried, then the caption fell back to text", /whatsapp_cloud\.media_upload_failed/.test(stackLog) && /messaging\.media_fallback_text/.test(stackLog));
  const graphLog = /whatsapp_cloud\.send_failed[^\n]*"httpStatus":(\d+)[^\n]*"providerCode":(\d+)/.exec(stackLog);
  check("the failure came from Meta (HTTP 401 / OAuth error 190)", Boolean(graphLog && graphLog[1] === "401" && graphLog[2] === "190"), graphLog ? `HTTP ${graphLog[1]}, code ${graphLog[2]}` : "no Graph response in the log (offline?)");
}

// ----------------------------------------------------------------- main
async function main() {
  console.log(`MarutiX WhatsApp bot end-to-end run ${RUN}\n  database: ${baseMongo.replace(/\/\/[^@]*@/, "//***@")}\n  web:      ${BASE}`);
  section("0. Start the full stack with scripts/dev.mjs (pilot provider, unpaired session)");
  await ensureMongo();
  const m = await loadModules();
  await m.connectToDatabase();
  try {
    await startStack("whatsapp_web");
    check("npm run dev launcher: web healthy, jobs worker and WhatsApp worker started", (await logShows(/\[jobs\][^\n]*jobs\.worker\.started/)) && (await logShows(/\[whatsapp\][^\n]*whatsapp\.worker\.started/)));
    await phaseOne(m);
    await stopStack();
    section("0b. Restart the stack with MESSAGING_PROVIDER=whatsapp_cloud");
    await startStack("whatsapp_cloud");
    check("cloud mode: the jobs worker drains the outbox; no WhatsApp Web worker", (await logShows(/whatsapp_cloud\.dispatcher_started/)) && !/\[whatsapp\]/.test(stackLog));
    await phaseTwo(m);
  } finally {
    await stopStack();
    await m.mongoose.connection.dropDatabase().catch((e: unknown) => console.error(`Couldn't drop the test database: ${e instanceof Error ? e.message : e}`));
    await m.mongoose.disconnect().catch(() => {});
    await stopOwnMongo();
    rmSync(SESSION_DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - [${f.phase}] ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  }
  console.log("Inbound messages were simulated, signed exactly as Meta signs them; everything after the webhook ran for real.");
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack : error);
  if (stackLog) console.error(`\n--- last stack output ---\n${stackLog.slice(-4000)}`);
  await stopStack();
  await stopOwnMongo();
  process.exit(1);
});
