/**
 * QA probe: edge cases for the WhatsApp bot through a REAL running MarutiX web app.
 *
 * Sends Meta-shaped, correctly signed webhook POSTs from synthetic numbers (+9190000xxxxx)
 * and prints every reply the bot queues in the outbox (a transcript to read by eye).
 * Same approach as scripts/e2e/whatsapp-bot-e2e.ts, but against an already-running stack
 * that was started on a THROWAWAY database with a test WHATSAPP_APP_SECRET:
 *
 *   QA_BASE=http://localhost:3000 MONGODB_URI=mongodb://127.0.0.1:27017/marutix_qa_xxx \
 *   WHATSAPP_APP_SECRET=... WHATSAPP_PHONE_NUMBER_ID=... \
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/qa/bot-probe.ts
 *
 * Refuses to run unless MONGODB_URI names a marutix_qa_* database.
 */
import { createHmac, randomUUID } from "node:crypto";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const SECRET = process.env.WHATSAPP_APP_SECRET ?? "";
const PNID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
if (!/\/marutix_qa_[a-z0-9_]+(\?|$)/.test(process.env.MONGODB_URI ?? "")) {
  console.error("Refusing: MONGODB_URI must point at a marutix_qa_* throwaway database.");
  process.exit(2);
}
if (!SECRET || !PNID) {
  console.error("WHATSAPP_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID are required.");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const envelope = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "QA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "910000000000", phone_number_id: PNID }, ...value } }] }],
});
async function post(payload: unknown) {
  const body = JSON.stringify(payload);
  return fetch(`${BASE}/api/v1/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) }, body });
}

async function main() {
  const { connectToDatabase } = await import("@/lib/db/mongoose");
  const mongoose = (await import("mongoose")).default;
  const { decryptPii, phoneLookupToken } = await import("@/lib/security/crypto");
  const { NotificationEvent } = await import("@/server/models/notification-event");
  await connectToDatabase();

  let n = 0;
  const findings: string[] = [];
  class Phone {
    seen = new Set<string>();
    e164: string;
    constructor(readonly label: string) {
      n += 1;
      this.e164 = `+9190000${String(Date.now() % 100000).padStart(5, "0").slice(0, 3)}${String(n).padStart(2, "0")}`;
    }
    get digits() {
      return this.e164.slice(1);
    }
    message(input: unknown, id: string, ts?: number) {
      const base = { from: this.digits, id, timestamp: String(ts ?? Math.floor(Date.now() / 1000)) };
      if (typeof input === "string") return { ...base, type: "text", text: { body: input } };
      return { ...base, ...(input as Record<string, unknown>) };
    }
    async send(input: unknown, opts: { id?: string; ts?: number; quiet?: boolean } = {}) {
      const id = opts.id ?? `wamid.QA${randomUUID().replace(/-/g, "")}`;
      const shown = typeof input === "string" ? JSON.stringify(input.length > 120 ? `${input.slice(0, 60)}…(${input.length} chars)` : input) : JSON.stringify(input).slice(0, 100);
      if (!opts.quiet) console.log(`  ${this.label} → ${shown}`);
      const t0 = Date.now();
      const res = await post(envelope({ contacts: [{ wa_id: this.digits, profile: { name: this.label } }], messages: [this.message(input, id, opts.ts)] }));
      const ms = Date.now() - t0;
      if (res.status !== 200) console.log(`    !! webhook HTTP ${res.status}`);
      const r = await this.replies();
      if (!opts.quiet) console.log(`    (${ms} ms)`);
      return r;
    }
    async replies() {
      const lookup = phoneLookupToken(this.e164);
      const events = await NotificationEvent.find({ recipientLookup: lookup }).sort({ createdAt: 1, _id: 1 }).lean();
      const out: string[] = [];
      for (const e of events) {
        const k = String(e._id);
        if (this.seen.has(k)) continue;
        this.seen.add(k);
        const body = e.bodyEncrypted ? decryptPii(e.bodyEncrypted) : `[${e.kind}${e.mediaKey ? ` media=${e.mediaKey}` : ""}: ${e.status}]`;
        out.push(body);
        console.log(body.split("\n").map((l, i) => `    ${i ? "  " : "← "}${l}`).join("\n"));
      }
      if (!out.length) console.log("    ← (no reply)");
      return out;
    }
  }
  const section = (t: string) => console.log(`\n=== ${t}`);
  const note = (ok: boolean, what: string) => {
    console.log(`  ${ok ? "OK  " : "ISSUE"} ${what}`);
    if (!ok) findings.push(what);
  };
  const has = (r: string[], re: RegExp) => r.some((x) => re.test(x));

  section("A. Hinglish / Hindi first messages");
  let p = new Phone("Hinglish1");
  let r = await p.send("khoon chahiye B+ Lucknow mein");
  note(has(r, /emergency blood request|patient's name/i), "'khoon chahiye B+ Lucknow mein' starts an emergency request");
  r = await p.send("CANCEL");
  p = new Phone("Hinglish2");
  r = await p.send("donor banna hai");
  note(has(r, /register you as a voluntary blood donor|What's your name/i), "'donor banna hai' starts donor registration");
  p = new Phone("Hinglish3");
  r = await p.send("mera request kaha tak pahucha");
  note(has(r, /request|track|MX-/i), "'mera request kaha tak pahucha' with no request gives a sensible answer");
  p = new Phone("Devanagari");
  r = await p.send("मुझे खून चाहिए O+ दिल्ली");
  note(has(r, /emergency blood request|patient's name/i), "Devanagari 'मुझे खून चाहिए O+ दिल्ली' starts an emergency request");
  r = await p.send("CANCEL");

  section("B. Typos");
  p = new Phone("Typo1");
  r = await p.send("regster");
  note(has(r, /register you as a voluntary blood donor|What's your name/i), "'regster' is understood as REGISTER");
  p = new Phone("Typo2");
  r = await p.send("reqest");
  note(has(r, /emergency blood request|patient's name/i), "'reqest' is understood as REQUEST");
  p = new Phone("Typo3");
  r = await p.send("stauts");

  section("C. MENU / BACK in the middle of flows");
  p = new Phone("MidFlow");
  await p.send("2");
  await p.send("Ravi");
  r = await p.send("BACK");
  note(has(r, /name/i), "BACK at blood group returns to the name question");
  await p.send("Ravi");
  r = await p.send("MENU");
  note(has(r, /menu|Reply with a number/i), "MENU mid-registration shows the menu");
  r = await p.send("2");
  r = await p.send("1");
  section("C2. BACK at the first question / MENU then free text");
  p = new Phone("BackFirst");
  await p.send("1");
  r = await p.send("BACK");
  note(r.length > 0, "BACK at the first request question gets a reply");

  section("D. Rapid duplicate and out-of-order messages");
  p = new Phone("Rapid");
  const dupId = `wamid.QADUP${randomUUID().replace(/-/g, "")}`;
  const msg = (body: string, id: string, ts: number) => post(envelope({ contacts: [{ wa_id: p.digits, profile: { name: "Rapid" } }], messages: [p.message(body, id, ts)] }));
  const now = Math.floor(Date.now() / 1000);
  const statuses = await Promise.all([msg("Hi", dupId, now), msg("Hi", dupId, now), msg("Hi", dupId, now)]);
  console.log(`  Rapid → "Hi" ×3 concurrently with the same message ID: HTTP ${statuses.map((s) => s.status).join(",")}`);
  r = await p.replies();
  const welcomeTexts = r.filter((x) => /Welcome to MarutiX/.test(x)).length;
  note(welcomeTexts === 1, `concurrent duplicate delivery yields exactly one welcome (got ${welcomeTexts}, ${r.length} events)`);
  console.log(`  Rapid → "2" then "Asha" concurrently (different IDs)`);
  await Promise.all([msg("2", `wamid.QA${randomUUID()}`, now + 1), msg("Asha", `wamid.QA${randomUUID()}`, now + 2)]);
  r = await p.replies();
  console.log(`  Rapid → out of order: "B+" (ts+10) delivered before "Kumar" (ts+5)`);
  await msg("B+", `wamid.QA${randomUUID()}`, now + 10);
  await msg("Kumar", `wamid.QA${randomUUID()}`, now + 5);
  r = await p.replies();

  section("E. Emoji-only, very long, empty, whitespace");
  p = new Phone("Emoji");
  r = await p.send("🩸🙏");
  note(r.length > 0, "emoji-only first message gets a reply");
  r = await p.send("👍");
  p = new Phone("Long");
  r = await p.send("I need blood ".repeat(800));
  note(r.length > 0 && r.every((x) => x.length < 4096), "a ~10 kB message gets a bounded reply");
  p = new Phone("Empty");
  r = await p.send("");
  console.log(`    empty text: ${r.length} replies`);
  r = await p.send("   \n  ");
  console.log(`    whitespace text: ${r.length} replies`);

  section("F. STOP in mid-flow then START");
  p = new Phone("StopMid");
  await p.send("1");
  await p.send("A. B.");
  r = await p.send("STOP");
  note(has(r, /unsubscribed/i), "STOP mid-request confirms the opt-out");
  r = await p.send("O+");
  note(r.length === 0, "after STOP, a flow answer gets no reply");
  r = await p.send("START");
  note(r.length > 0, "START answers again");
  r = await p.send("O+");
  console.log("    (what happens to the abandoned request flow after START?)");
  section("F2. 'stop' inside a sentence");
  p = new Phone("StopWord");
  await p.send("Hi");
  r = await p.send("please don't stop helping");

  section("G. Location as the very first message");
  p = new Phone("LocFirst");
  r = await p.send({ type: "location", location: { latitude: 26.8467, longitude: 80.9462 } });
  note(r.some((x) => /Welcome|menu|location/i.test(x)), "a location as first message gets a sensible reply");

  section("H. Alert replies with no alert");
  p = new Phone("NoAlert");
  r = await p.send("INTERESTED");
  note(r.length > 0 && !has(r, /recorded/i), "INTERESTED with no alert doesn't record anything and explains");
  r = await p.send("1");
  r = await p.send("NOT AVAILABLE");
  p = new Phone("NoAlert2");
  r = await p.send("4");
  section("H2. Reply with the request id of somebody else's request");
  p = new Phone("Snoop");
  r = await p.send("TRACK MX-AAAAAAAA");

  section("I. Interactive / button / image with caption / contacts / reaction");
  p = new Phone("Media");
  r = await p.send({ type: "image", image: { id: "QAIMG", mime_type: "image/jpeg", caption: "need blood B+ Kanpur" } });
  r = await p.send({ type: "reaction", reaction: { message_id: "x", emoji: "👍" } });
  r = await p.send({ type: "contacts", contacts: [{ name: { formatted_name: "X" } }] });
  r = await p.send({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b", title: "Help" } } });

  console.log(`\n${findings.length} potential issue(s):`);
  for (const f of findings) console.log(`  - ${f}`);
  await mongoose.disconnect();
  await sleep(100);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
