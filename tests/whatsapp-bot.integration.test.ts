import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { resetWhatsAppMediaConfigForTests } from "@/lib/whatsapp/media-config";
import { setAiProviderForTests } from "@/server/ai/interpret";
import { WELCOME_MENU_TEXT } from "@/server/conversations/menu";
import { getDonorOverview, registerDonor } from "@/server/donors/service";
import { dispatchNext, dispatchOne } from "@/server/messaging/dispatcher";
import { handleInboundMessage, type InboundEvent } from "@/server/messaging/inbound";
import { SendPacer } from "@/server/messaging/pacing";
import { MessagingError, type MessagingProvider } from "@/server/messaging/provider";
import { enqueueMessage, queueBotReplies, queueEmergencyRequestNotification } from "@/server/messaging/queue";
import { recordOptOut } from "@/server/messaging/opt-out";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { RequestResponse } from "@/server/models/request-response";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";
import { getTrackedRequest } from "@/server/requests/service";
import { findOrCreateVerifiedUser } from "@/server/services/users";
import { alertSummaryFor, createActiveRequest, randomMobile } from "./helpers/fixtures";

/**
 * The first-contact menu, the welcome image, unsupported inputs, media
 * fallback, reply speed and web sync, through the real inbound pipeline and
 * outbox against MongoDB. WhatsApp itself is a fake provider.
 * Run with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test_whatsapp npx vitest run tests/whatsapp-bot.integration.test.ts
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
const send = (phone: string, text: string, now?: Date) =>
  handleInboundMessage({ providerMessageId: `wa-${randomUUID()}-${seq++}`, fromE164: phone, input: { type: "text", text } }, now);
const sendEvent = (event: Omit<InboundEvent, "providerMessageId">, now?: Date) =>
  handleInboundMessage({ providerMessageId: `wa-${randomUUID()}-${seq++}`, ...event } as InboundEvent, now);

async function outbox(phone: string) {
  const docs = await NotificationEvent.find({ recipientLookup: phoneLookupToken(phone) }).sort({ createdAt: 1, _id: 1 }).lean();
  return docs.map((d) => ({ ...d, body: d.bodyEncrypted ? decryptPii(d.bodyEncrypted) : null }));
}
const lastReply = async (phone: string) => (await outbox(phone)).at(-1)?.body ?? "";
const conversationOf = (phone: string) => WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();

/** A WhatsApp stand-in that can send images, or fail them in a chosen way. */
function fakeWhatsApp(options: { imageError?: MessagingError } = {}) {
  const sent: { type: "text" | "image"; to: string; body: string; file?: string }[] = [];
  const provider: MessagingProvider = {
    name: "whatsapp_web",
    isReady: () => true,
    async sendText(to, body) {
      sent.push({ type: "text", to, body });
      return { providerMessageId: `w-${randomUUID()}` };
    },
    async sendImage(to, image, caption) {
      if (options.imageError) throw options.imageError;
      sent.push({ type: "image", to, body: caption, file: image.filePath });
      return { providerMessageId: `w-${randomUUID()}` };
    },
  };
  return { provider, sent };
}
const dispatchOptions = () => ({ maxMessagesPerHour: 1000, maxRepliesPerHour: 1000, testRecipients: getWhatsAppWebConfig().testRecipients });
async function drain(provider: MessagingProvider, now = new Date()) {
  for (let i = 0; i < 50; i++) {
    const r = await dispatchNext(provider, dispatchOptions(), now);
    if (r === "idle" || r === "rate_limited") return;
  }
}

async function registeredDonor(phone = randomMobile("7")) {
  const { user } = await findOrCreateVerifiedUser(phone, phoneLookupToken(phone));
  await registerDonor(
    user._id,
    {
      name: "Asha Verma",
      bloodGroup: "B+",
      city: "Prayagraj",
      locality: "Civil Lines",
      location: null,
      lastDonationDate: null,
      availableForRequests: true,
      notificationConsent: true,
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    },
    { requestId: "t" },
  );
  return { phone, userId: user._id };
}

describe.skipIf(!enabled)("WhatsApp bot: first contact, media, reliability, speed (MongoDB)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all([User, DonorProfile, NotificationEvent, WhatsAppConversation, WhatsAppInboundMessage, RequestResponse, EmergencyRequest].map((m) => m.syncIndexes()));
  });
  afterEach(() => {
    delete process.env.WHATSAPP_WELCOME_IMAGE_ENABLED;
    resetWhatsAppMediaConfigForTests();
    setAiProviderForTests(undefined);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  describe("welcome image on the first contact", () => {
    it("sends the menu as the image's caption, once per number ever, then erases the caption", async () => {
      await NotificationEvent.deleteMany({});
      const phone = randomMobile("9");
      await send(phone, "Hi");
      const [welcome] = await outbox(phone);
      expect(welcome).toMatchObject({ kind: "bot_reply", templateName: "bot_menu", mediaKey: "welcome", body: WELCOME_MENU_TEXT });
      expect(welcome.idempotencyKey).toBe(`welcome_image:${phoneLookupToken(phone)}`);

      const { provider, sent } = fakeWhatsApp();
      await drain(provider);
      expect(sent).toEqual([{ type: "image", to: phone, body: WELCOME_MENU_TEXT, file: expect.stringMatching(/public\/whatsapp\/welcome\.png$/) }]);
      const after = await NotificationEvent.findById(welcome._id).lean();
      expect(after).toMatchObject({ status: "sent", mediaOutcome: "image" });
      expect(after?.bodyEncrypted).toBeUndefined(); // caption erased after sending, like any text

      // Later messages, even after the menu closes and conversations expire, never repeat the image.
      await send(phone, "5");
      await WhatsAppConversation.deleteMany({ phoneLookup: phoneLookupToken(phone) });
      await WhatsAppInboundMessage.deleteMany({ phoneLookup: phoneLookupToken(phone) });
      await send(phone, "hello", new Date(Date.now() + 2 * DAY));
      expect((await outbox(phone)).filter((m) => m.mediaKey)).toHaveLength(1);
    });

    it("isn't attached to an emergency request, so the questions and 112 advice go first", async () => {
      const phone = randomMobile("9");
      await send(phone, "REQUEST");
      const messages = await outbox(phone);
      expect(messages.some((m) => m.mediaKey)).toBe(false);
      expect(messages[0].body).toMatch(/emergency blood request[\s\S]*call 112/);
    });

    it("comes with the registration intro when the first message is REGISTER", async () => {
      const phone = randomMobile("9");
      await send(phone, "REGISTER");
      const [first] = await outbox(phone);
      expect(first).toMatchObject({ mediaKey: "welcome" });
      expect(first.body).toMatch(/register you as a voluntary blood donor[\s\S]*What's your name/);
    });

    it("never goes to a number that opted out, a verified institution contact, or when switched off", async () => {
      const stopped = randomMobile("9");
      await send(stopped, "STOP");
      await send(stopped, "hi");
      expect((await outbox(stopped)).map((m) => m.kind)).toEqual(["opt_out_confirmation"]);

      const institutionId = new Types.ObjectId();
      const staff = randomMobile("6");
      await Institution.collection.insertOne({ _id: institutionId, verificationStatus: "verified" });
      await InstitutionContact.collection.insertOne({ institutionId, phoneLookup: phoneLookupToken(staff), status: "verified" });
      await send(staff, "hello");
      expect((await outbox(staff)).some((m) => m.mediaKey)).toBe(false);

      process.env.WHATSAPP_WELCOME_IMAGE_ENABLED = "false";
      resetWhatsAppMediaConfigForTests();
      const plain = randomMobile("9");
      await send(plain, "Hi");
      const [menu] = await outbox(plain);
      expect(menu.mediaKey).toBeUndefined();
      expect(menu.body).toBe(WELCOME_MENU_TEXT);
    });

    it("re-checks opt-out at sending time: a STOP after queueing suppresses the image", async () => {
      await NotificationEvent.deleteMany({});
      const phone = randomMobile("9");
      await send(phone, "Hi");
      await recordOptOut(phone, "whatsapp_stop");
      const { provider, sent } = fakeWhatsApp();
      await drain(provider);
      expect(sent.filter((s) => s.to === phone && s.type === "image")).toHaveLength(0);
      expect((await outbox(phone)).find((m) => m.mediaKey)).toMatchObject({ status: "suppressed", failureCode: "OPTED_OUT" });
    });

    it("falls back to the caption as text when the image provably wasn't sent, exactly once", async () => {
      await NotificationEvent.deleteMany({});
      const phone = randomMobile("9");
      await send(phone, "Hi");
      const { provider, sent } = fakeWhatsApp({ imageError: new MessagingError("MEDIA_UNAVAILABLE", false, true) });
      await drain(provider);
      expect(sent).toEqual([{ type: "text", to: phone, body: WELCOME_MENU_TEXT }]);
      expect((await outbox(phone))[0]).toMatchObject({ status: "sent", mediaOutcome: "text_fallback" });
    });

    it("doesn't follow an image that may have gone out with text (no duplicate), and doesn't retry it", async () => {
      await NotificationEvent.deleteMany({});
      const phone = randomMobile("9");
      await send(phone, "Hi");
      const { provider, sent } = fakeWhatsApp({ imageError: new MessagingError("SEND_TIMEOUT", false, false) });
      await drain(provider);
      expect(sent).toHaveLength(0);
      expect((await outbox(phone))[0]).toMatchObject({ status: "failed", failureCode: "SEND_TIMEOUT", attempts: 1 });
    });
  });

  describe("START after STOP", () => {
    it("a family that stopped mid-request is resubscribed and shown the menu, never pushed into donor registration", async () => {
      const phone = randomMobile("9");
      await send(phone, "1");
      await send(phone, "A. B.");
      expect(await send(phone, "STOP")).toBe("opt_out");
      await send(phone, "START");
      const reply = await lastReply(phone);
      expect(reply).toMatch(/subscribed to MarutiX messages again/);
      expect(reply).toMatch(/1\. I need blood for a patient/);
      expect(reply).not.toMatch(/register you as a voluntary blood donor|What's your name/);
      expect((await conversationOf(phone))?.flow).toBe("main_menu");
      expect(await MessagingOptOut.countDocuments({ phoneLookup: phoneLookupToken(phone) })).toBe(0);
      // The menu works again straight away.
      await send(phone, "1");
      expect(await lastReply(phone)).toMatch(/patient's name/i);
    });

    it("a registered donor is resubscribed but alerts stay off until they turn them on themselves", async () => {
      const phone = randomMobile("7");
      await registeredDonor(phone);
      await send(phone, "STOP");
      await send(phone, "START");
      const reply = await lastReply(phone);
      expect(reply).toMatch(/subscribed to MarutiX messages again[\s\S]*alerts are still off[\s\S]*UPDATE and choose 7/);
      expect(reply).toMatch(/Emergency alerts: Off/);
    });

    it("START from a brand-new number is a normal first contact with the welcome menu", async () => {
      const phone = randomMobile("9");
      await send(phone, "START");
      expect(await lastReply(phone)).toMatch(/Welcome to MarutiX[\s\S]*1\. I need blood for a patient/);
    });
  });

  describe("first-contact menu", () => {
    it("a bare digit as the very first message acts on that option instead of showing the menu first", async () => {
      const donor = randomMobile("9");
      await send(donor, "2");
      expect(await lastReply(donor)).toMatch(/Welcome to MarutiX 🩸 Let's register you as a voluntary blood donor[\s\S]*What's your name/);
      expect((await conversationOf(donor))?.flow).toBe("donor_onboarding");

      const family = randomMobile("9");
      await send(family, "1");
      expect(await lastReply(family)).toMatch(/emergency blood request[\s\S]*patient's name/i);
      expect((await conversationOf(family))?.flow).toBe("emergency_request");
    });

    it("BACK while the menu is open shows the menu again instead of 'didn't get that'", async () => {
      const phone = randomMobile("9");
      await send(phone, "Hi");
      await send(phone, "BACK");
      const reply = await lastReply(phone);
      expect(reply).toMatch(/MarutiX menu[\s\S]*1\. I need blood/);
      expect(reply).not.toMatch(/didn't get that/);
    });

    it("1 starts an emergency request", async () => {
      const phone = randomMobile("9");
      await send(phone, "Hi");
      await send(phone, "1");
      expect(await lastReply(phone)).toMatch(/emergency blood request[\s\S]*patient's name/i);
      expect((await conversationOf(phone))?.flow).toBe("emergency_request");
    });

    it("2 (or YES, or haan) starts donor registration, and the profile then shows on the web dashboard", async () => {
      const phone = randomMobile("9");
      await send(phone, "Namaste");
      await send(phone, "2");
      expect(await lastReply(phone)).toMatch(/What's your name/);
      for (const t of ["Kiran Rao", "B-", "Pune", "Kothrud", "skip", "skip", "1", "yes", "yes"]) await send(phone, t);
      expect(await lastReply(phone)).toMatch(/You're registered, Kiran/);
      const { user } = await findOrCreateVerifiedUser(phone, phoneLookupToken(phone));
      expect((await getDonorOverview(user._id)).profile).toMatchObject({ name: "Kiran Rao", bloodGroup: "B-", city: "Pune", registeredVia: "whatsapp" });

      const other = randomMobile("9");
      await send(other, "hello");
      await send(other, "haan");
      expect(await lastReply(other)).toMatch(/What's your name/);
    });

    it("3 tracks, 4 helps, NO declines; each closes the menu", async () => {
      const a = randomMobile("9");
      await send(a, "hi");
      await send(a, "3");
      expect(await lastReply(a)).toMatch(/couldn't find a recent blood request/);
      expect((await conversationOf(a))?.status).toBe("completed");

      const b = randomMobile("9");
      await send(b, "hi");
      await send(b, "4");
      expect(await lastReply(b)).toMatch(/^MarutiX coordinates emergency blood requests/);

      const c = randomMobile("9");
      await send(c, "hi");
      await send(c, "no");
      expect(await lastReply(c)).toMatch(/Reply MENU any time/);
      const count = (await outbox(c)).length;
      await send(c, "ok thanks"); // not a greeting: no unprompted menu right after declining
      expect((await outbox(c)).length).toBe(count);
      await send(c, "MENU");
      expect(await lastReply(c)).toMatch(/^MarutiX menu\. Reply with a number/);
    });

    it("understands Hinglish free text at the menu and keeps the details it found", async () => {
      const phone = randomMobile("9");
      await send(phone, "hi");
      await send(phone, "Lucknow mein B+ khoon chahiye");
      const reply = await lastReply(phone);
      expect(reply).toMatch(/noted the details/);
      expect(reply).not.toMatch(/blood group\?/i);
      expect((await conversationOf(phone))?.flow).toBe("emergency_request");

      const donor = randomMobile("9");
      await send(donor, "hi");
      await send(donor, "donor banna hai");
      expect(await lastReply(donor)).toMatch(/What's your name/);
    });

    it("re-shows the menu with a hint for unclear replies, then closes quietly after three", async () => {
      const phone = randomMobile("9");
      await send(phone, "hi");
      await send(phone, "zzz");
      expect(await lastReply(phone)).toMatch(/^Sorry, I didn't get that[\s\S]*1\. I need blood/);
      await sendEvent({ fromE164: phone, input: { type: "location", latitude: 25.4, longitude: 81.8 } });
      expect(await lastReply(phone)).toMatch(/choose an option/);
      await send(phone, "qqq");
      expect(await lastReply(phone)).toMatch(/Reply MENU whenever/);
      expect((await conversationOf(phone))?.status).toBe("cancelled");
      const count = (await outbox(phone)).length;
      await send(phone, "www");
      expect((await outbox(phone)).length).toBe(count); // no loop
    });

    it("MENU sets a flow aside from anywhere; BACK at a flow's first question returns to the menu", async () => {
      const phone = randomMobile("9");
      await send(phone, "REGISTER");
      await send(phone, "Ravi");
      await send(phone, "MENU");
      expect(await lastReply(phone)).toMatch(/^Your earlier conversation was set aside\.[\s\S]*Reply with a number/);
      expect((await conversationOf(phone))?.flow).toBe("main_menu");

      await send(phone, "1");
      await send(phone, "back");
      expect(await lastReply(phone)).toMatch(/request was stopped\. Nothing was submitted\.[\s\S]*Reply with a number/);
      await send(phone, "2");
      expect(await lastReply(phone)).toMatch(/What's your name/);
    });

    it("continues a conversation saved at the old YES/NO question", async () => {
      const phone = randomMobile("9");
      await WhatsAppConversation.create({
        phoneLookup: phoneLookupToken(phone),
        flow: "donor_onboarding",
        status: "active",
        state: "await_start",
        history: [],
        dataEncrypted: encryptPii("{}"),
        startedVia: "whatsapp",
        lastInboundAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
      });
      await send(phone, "YES");
      expect(await lastReply(phone)).toMatch(/What's your name/);
    });

    it("a numbered reply to a fresh emergency alert is the alert answer, not a menu choice", async () => {
      const donor = await registeredDonor();
      const request = await createActiveRequest();
      await NotificationEvent.deleteMany({ status: "queued" });
      await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(request) });
      await drain(fakeWhatsApp().provider);
      await send(donor.phone, "MENU");
      await send(donor.phone, "1");
      expect(await RequestResponse.countDocuments({ requestId: request._id, donorUserId: donor.userId, response: "interested" })).toBe(1);
      expect(await lastReply(donor.phone)).toMatch(/May we share/);
    });
  });

  describe("unexpected input and failures", () => {
    it("answers photos, voice notes and stickers with one line a day, never after STOP", async () => {
      const phone = randomMobile("9");
      expect(await sendEvent({ fromE164: phone, input: { type: "unsupported", mediaType: "ptt" } })).toBe("unsupported");
      await sendEvent({ fromE164: phone, input: { type: "unsupported", mediaType: "sticker" } });
      let replies = await outbox(phone);
      expect(replies).toHaveLength(1);
      expect(replies[0].body).toMatch(/I can only read text messages and shared locations/);

      await sendEvent({ fromE164: phone, input: { type: "unsupported", mediaType: "image" } }, new Date(Date.now() + DAY + 60_000));
      expect(await outbox(phone)).toHaveLength(2);

      await send(phone, "STOP");
      replies = await outbox(phone);
      await sendEvent({ fromE164: phone, input: { type: "unsupported", mediaType: "image" } }, new Date(Date.now() + 3 * DAY));
      expect(await outbox(phone)).toHaveLength(replies.length);
    });

    it("drops empty messages without a reply", async () => {
      const phone = randomMobile("9");
      expect(await send(phone, "   ")).toBe("empty");
      expect(await outbox(phone)).toHaveLength(0);
    });

    it("falls back to the keyword rules when the AI provider fails", async () => {
      setAiProviderForTests({
        name: "broken",
        interpret: async () => {
          throw new Error("network down");
        },
      });
      const phone = randomMobile("9");
      await send(phone, "hi");
      await send(phone, "khoon chahiye B+");
      expect((await conversationOf(phone))?.flow).toBe("emergency_request");
    });
  });

  describe("web sync", () => {
    it("a request made on WhatsApp is the one the tracking page shows", async () => {
      const phone = randomMobile("9");
      await send(phone, "hi");
      await send(phone, "1");
      for (const t of ["S. D.", "skip", "Rohit Kumar", "B+", "1", "1", "in 6 hours", "1", "City Hospital", "Prayagraj", "Civil Lines", "12 MG Road", "skip", "yes"]) await send(phone, t);
      const confirmation = await lastReply(phone);
      const request = await EmergencyRequest.findOne({ requesterPhoneLookup: phoneLookupToken(phone) }).lean();
      expect(confirmation).toMatch(new RegExp(`Request ${request!.publicRequestId} is now active`));
      const token = /\/track\/([^\s/]+)/.exec(confirmation)?.[1];
      expect(token).toBeTruthy();
      const tracked = await getTrackedRequest(token!);
      expect(tracked).toMatchObject({ publicRequestId: request!.publicRequestId, status: "active", bloodGroup: "B+" });
    });
  });

  describe("reply speed (fake clock)", () => {
    /** Drives the outbox like the pilot worker's loop, on virtual time; returns when each message went out. */
    async function run(pacing: "before" | "after", maxMs = 60_000) {
      const config = getWhatsAppWebConfig();
      const pacer = new SendPacer({ replyIntervalMs: config.replyIntervalMs, proactiveIntervalMs: config.minSendIntervalMs, idlePollMs: 2000, rateLimitedPollMs: 30_000 });
      const sentAt: { at: number; kind: string }[] = [];
      const provider: MessagingProvider = {
        name: "whatsapp_web",
        isReady: () => true,
        sendText: async () => ({ providerMessageId: `w-${randomUUID()}` }),
      };
      const base = Date.now();
      for (let t = 0; t <= maxMs; ) {
        const now = new Date(base + t);
        const before = await NotificationEvent.countDocuments({ status: "sent" });
        const result = await dispatchOne(provider, { ...dispatchOptions(), proactiveAllowed: pacing === "before" ? true : pacer.proactiveAllowed(t) }, now);
        if ((await NotificationEvent.countDocuments({ status: "sent" })) > before) sentAt.push({ at: t, kind: result.conversational ? "reply" : "proactive" });
        if (result.outcome === "idle") break;
        // Before: every send waited WHATSAPP_WEB_MIN_SEND_INTERVAL_MS. After: the pacer decides.
        t += pacing === "before" ? (result.outcome === "suppressed" ? 0 : config.minSendIntervalMs) : pacer.delayAfter(result.outcome, t);
      }
      return sentAt;
    }
    const parts = ["Welcome to MarutiX 🩸 Let's register you as a voluntary blood donor. It takes about 2 minutes.", "What's your name?", "(At any point, reply BACK to go back or CANCEL to stop.)"];

    it("a 3-part reply: ~8 s before, at once after merging; alerts keep 4 s spacing", async () => {
      const phone = randomMobile("9");

      // Before: three separate messages, each followed by the 4 s pilot interval.
      await NotificationEvent.deleteMany({});
      const inbound = `speed-${randomUUID()}`;
      for (const [i, body] of parts.entries()) {
        await enqueueMessage({ kind: "bot_reply", templateName: "bot_reply", phoneE164: phone, body, idempotencyKey: `old:${inbound}:${i}`, recordSuppressed: false });
      }
      const before = await run("before");

      // After: the same reply merged into one message, with the short reply interval.
      await NotificationEvent.deleteMany({});
      await queueBotReplies(phone, `speed-${randomUUID()}`, parts);
      const after = await run("after");

      // Even unmerged, three parts now take 2 s instead of 8 s.
      await NotificationEvent.deleteMany({});
      for (const [i, body] of parts.entries()) {
        await enqueueMessage({ kind: "bot_reply", templateName: "bot_reply", phoneE164: phone, body, idempotencyKey: `new:${inbound}:${i}`, recordSuppressed: false });
      }
      const unmerged = await run("after");

      console.info(
        `[reply speed] last part of a 3-part reply delivered after: before ${before.at(-1)!.at} ms (${before.length} messages); ` +
          `after ${after.at(-1)!.at} ms (${after.length} message); unmerged with the new interval ${unmerged.at(-1)!.at} ms`,
      );
      expect(before.map((s) => s.at)).toEqual([0, 4000, 8000]);
      expect(after.map((s) => s.at)).toEqual([0]);
      expect(unmerged.map((s) => s.at)).toEqual([0, 1000, 2000]);

      // Proactive messages keep the conservative pace, even right after replies.
      await NotificationEvent.deleteMany({});
      const testRecipient = [...getWhatsAppWebConfig().testRecipients][0];
      for (let i = 0; i < 2; i++) {
        await enqueueMessage({ kind: "admin_test", templateName: "admin_test_text", phoneE164: testRecipient, body: `alert ${i}`, idempotencyKey: `pro:${inbound}:${i}`, recordSuppressed: false });
      }
      for (const [i, body] of parts.entries()) {
        await enqueueMessage({ kind: "bot_reply", templateName: "bot_reply", phoneE164: phone, body, idempotencyKey: `mix:${inbound}:${i}`, recordSuppressed: false });
      }
      const mixed = await run("after");
      expect(mixed.map((s) => s.kind)).toEqual(["reply", "reply", "reply", "proactive", "proactive"]);
      const proactive = mixed.filter((s) => s.kind === "proactive").map((s) => s.at);
      expect(proactive[0] - 2000).toBeGreaterThanOrEqual(4000); // 4 s after the last reply
      expect(proactive[1] - proactive[0]).toBeGreaterThanOrEqual(4000);
    });
  });
});
