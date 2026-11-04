import { randomInt, randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { changeNotifications, changePhoneNumber, getDonorOverview, registerDonor, setAvailability, updateDonorProfile } from "@/server/donors/service";
import { dispatchNext } from "@/server/messaging/dispatcher";
import { handleInboundMessage } from "@/server/messaging/inbound";
import type { MessagingProvider } from "@/server/messaging/provider";
import { queueAdminTestMessage, queueEmergencyRequestNotification } from "@/server/messaging/queue";
import { findOrCreateVerifiedUser } from "@/server/services/users";
import { ConsentRecord } from "@/server/models/consent-record";
import { DonorProfile } from "@/server/models/donor-profile";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";
import { alertSummaryFor, createActiveRequest } from "./helpers/fixtures";

/**
 * Donor registration, preferences and the WhatsApp onboarding bot, end to end
 * through the real inbound router and outbox (WhatsApp itself is faked).
 * Enable with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test npm test
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);

const randomPhone = () => `+917${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

async function createUser(phone = randomPhone()) {
  const user = await User.create({
    phoneLookup: phoneLookupToken(phone),
    phoneEncrypted: encryptPii(phone),
    phoneVerifiedAt: new Date(),
    role: "donor",
    status: "active",
  });
  return { phone, userId: user._id };
}

const registration = (overrides: Record<string, unknown> = {}) => ({
  name: "Asha Verma",
  bloodGroup: "B+" as const,
  city: "Lucknow",
  locality: "Gomti Nagar",
  location: { latitude: 26.851234, longitude: 80.998765 },
  lastDonationDate: "2025-06-01",
  availableForRequests: true,
  notificationConsent: true,
  privacyNoticeVersion: PRIVACY_NOTICE_VERSION as typeof PRIVACY_NOTICE_VERSION,
  ...overrides,
});

/** Simulates WhatsApp delivering a message from `phone`. */
let seq = 0;
const say = (phone: string, text: string, now?: Date) =>
  handleInboundMessage({ providerMessageId: `in-${randomUUID()}-${seq++}`, fromE164: phone, input: { type: "text", text } }, now);

/** Bot replies queued for a number, oldest first (bodies still encrypted in the outbox). */
async function repliesTo(phone: string) {
  const docs = await NotificationEvent.find({ recipientLookup: phoneLookupToken(phone) }).sort({ createdAt: 1, _id: 1 }).lean();
  return docs.map((d) => ({ kind: d.kind, status: d.status, body: d.bodyEncrypted ? decryptPii(d.bodyEncrypted) : null }));
}
const lastReply = async (phone: string) => (await repliesTo(phone)).at(-1)?.body ?? "";

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe.skipIf(!enabled)("Donor module (MongoDB)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all(
      [User, DonorProfile, NotificationEvent, MessagingOptOut, WhatsAppConversation, WhatsAppInboundMessage, ConsentRecord].map((m) => m.syncIndexes()),
    );
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  describe("donor profile service", () => {
    it("registers once, coarsens location and records consent", async () => {
      const { phone, userId } = await createUser();
      const view = await registerDonor(userId, registration(), { requestId: "t" });

      expect(view).toMatchObject({ name: "Asha Verma", bloodGroup: "B+", city: "Lucknow", registeredVia: "whatsapp", availableForRequests: true });
      expect(view.location).toMatchObject({ latitude: 26.85, longitude: 81 });
      expect(view.notifications.status).toBe("active");
      expect(await ConsentRecord.countDocuments({ userId, action: "granted", noticeVersion: PRIVACY_NOTICE_VERSION })).toBe(1);
      expect(await repliesTo(phone)).toEqual([]); // the bot sends its own confirmation in the chat

      await expectAppError(registerDonor(userId, registration(), { requestId: "t" }), "DONOR_ALREADY_REGISTERED");
      expect(await DonorProfile.countDocuments({ userId })).toBe(1);
    });

    it("sends nothing and stores no consent when alerts are declined", async () => {
      const { phone, userId } = await createUser();
      const view = await registerDonor(userId, registration({ notificationConsent: false, location: null, lastDonationDate: null }), { requestId: "t" });
      expect(view.notifications.status).toBe("not_enabled");
      expect(view.location).toBeNull();
      expect(await repliesTo(phone)).toEqual([]);
      expect(await ConsentRecord.countDocuments({ userId })).toBe(0);
    });

    it("updates fields, removes location and changes availability", async () => {
      const { userId } = await createUser();
      await registerDonor(userId, registration(), { requestId: "t" });
      const updated = await updateDonorProfile(userId, { name: "Asha V", city: "Kanpur", location: null, lastDonationDate: null }, "t");
      expect(updated).toMatchObject({ name: "Asha V", city: "Kanpur", locality: "Gomti Nagar", location: null, lastDonationDate: null });
      expect((await setAvailability(userId, false, "t")).availableForRequests).toBe(false);
    });

    it("moves through enable, pause, resume and opt out, honouring opt-out immediately", async () => {
      const { phone, userId } = await createUser();
      await registerDonor(userId, registration({ notificationConsent: false }), { requestId: "t" });
      await expectAppError(changeNotifications(userId, "pause", "web", "t"), "CONFLICT");

      expect((await changeNotifications(userId, "enable", "web", "t")).notifications.status).toBe("active");
      expect((await changeNotifications(userId, "pause", "web", "t")).notifications.status).toBe("paused");
      expect((await changeNotifications(userId, "resume", "web", "t")).notifications.status).toBe("active");

      // A queued message is suppressed the moment the donor opts out.
      await queueAdminTestMessage({ phoneE164: phone, text: "hi", adminUserId: new Types.ObjectId(), idempotencyKey: randomUUID(), requestId: "t" });
      expect((await changeNotifications(userId, "opt_out", "web", "t")).notifications.status).toBe("opted_out");
      expect((await repliesTo(phone)).find((r) => r.kind === "admin_test")?.status).toBe("suppressed");
      expect(await MessagingOptOut.countDocuments({ phoneLookup: phoneLookupToken(phone) })).toBe(1);

      // Re-enabling is an explicit choice that lifts the suppression.
      expect((await changeNotifications(userId, "enable", "web", "t")).notifications.status).toBe("active");
      expect(await MessagingOptOut.countDocuments({ phoneLookup: phoneLookupToken(phone) })).toBe(0);
      expect((await ConsentRecord.find({ userId }).sort({ createdAt: 1 }).lean()).map((r) => r.action)).toEqual([
        "granted", "paused", "resumed", "withdrawn", "granted",
      ]);
    });

    it("refuses to move an account onto a number another account uses", async () => {
      const a = await createUser();
      const b = await createUser();
      await expectAppError(changePhoneNumber(a.userId, phoneLookupToken(b.phone), encryptPii(b.phone), "t"), "PHONE_IN_USE");
      const fresh = randomPhone();
      await changePhoneNumber(a.userId, phoneLookupToken(fresh), encryptPii(fresh), "t");
      expect((await getDonorOverview(a.userId)).maskedPhone).toMatch(/XX/);
      expect(await User.exists({ phoneLookup: phoneLookupToken(fresh), _id: a.userId })).not.toBeNull();
    });
  });

  describe("WhatsApp onboarding bot", () => {
    it("registers a new donor through a full conversation", async () => {
      const phone = randomPhone();
      await say(phone, "Hi");
      expect(await lastReply(phone)).toMatch(/Would you like to register/);

      for (const [answer, expectNext] of [
        ["Yes", /What's your name/],
        ["Rahul Sharma", /blood group/],
        ["O+", /Which city/],
        ["Prayagraj", /locality or area in Prayagraj/],
        ["Civil Lines", /share your location/],
        ["skip", /last donate/],
        ["skip", /available to donate/],
        ["1", /WhatsApp alerts/],
        ["yes", /Please check your details/],
      ] as const) {
        await say(phone, answer);
        expect(await lastReply(phone)).toMatch(expectNext);
      }
      await say(phone, "YES");
      expect(await lastReply(phone)).toMatch(/You're registered, Rahul/);

      const user = await User.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
      const profile = await DonorProfile.findOne({ userId: user!._id }).lean();
      expect(user?.displayName).toBe("Rahul Sharma");
      expect(profile).toMatchObject({ bloodGroup: "O+", city: "Prayagraj", locality: "Civil Lines", registeredVia: "whatsapp", availableForRequests: true });
      expect(profile?.notificationConsentAt).toBeInstanceOf(Date);

      const conversation = await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
      expect(conversation?.status).toBe("completed");
      expect(decryptPii(conversation!.dataEncrypted)).toBe("{}"); // answers erased once finished

      // Sending JOIN again doesn't create a duplicate.
      await say(phone, "JOIN");
      const [notice, status] = (await repliesTo(phone)).slice(-2).map((r) => r.body);
      expect(notice).toMatch(/already registered/);
      expect(status).toMatch(/Blood group: O\+/);
      expect(await DonorProfile.countDocuments({ userId: user!._id })).toBe(1);
    });

    it("handles invalid answers, BACK, and resumes an interrupted registration", async () => {
      const phone = randomPhone();
      await say(phone, "join");
      await say(phone, "Meera");
      await say(phone, "Z positive");
      expect(await lastReply(phone)).toMatch(/didn't recognise/);
      await say(phone, "back");
      expect(await lastReply(phone)).toMatch(/What's your name/);
      await say(phone, "Meera Iyer");

      // Two days later the donor writes again: progress is still there.
      const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      await say(phone, "hello?", later);
      const replies = await repliesTo(phone);
      expect(replies.at(-2)?.body).toMatch(/Welcome back/);
      expect(replies.at(-1)?.body).toMatch(/blood group/);
      const conversation = await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
      expect(conversation?.state).toBe("blood_group");
    });

    it("processes each WhatsApp message only once", async () => {
      const phone = randomPhone();
      const message = { providerMessageId: `dup-${randomUUID()}`, fromE164: phone, input: { type: "text" as const, text: "JOIN" } };
      expect(await handleInboundMessage(message)).toBe("handled");
      expect(await handleInboundMessage(message)).toBe("duplicate");
      expect((await repliesTo(phone)).length).toBe(2);
    });

    it("STOP mid-registration opts out immediately; only JOIN brings the bot back", async () => {
      const phone = randomPhone();
      await say(phone, "join");
      await say(phone, "Vikram");
      expect(await say(phone, "STOP")).toBe("opt_out");

      expect((await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(phone) }).lean())?.status).toBe("cancelled");
      expect(await MessagingOptOut.countDocuments({ phoneLookup: phoneLookupToken(phone) })).toBe(1);
      const afterStop = (await repliesTo(phone)).length;

      await say(phone, "hello");
      expect((await repliesTo(phone)).length).toBe(afterStop); // silence

      await say(phone, "JOIN");
      expect(await MessagingOptOut.countDocuments({ phoneLookup: phoneLookupToken(phone) })).toBe(0);
      expect(await lastReply(phone)).toMatch(/What's your name/);
    });

    it("lets a registered donor PAUSE, RESUME and check STATUS", async () => {
      const { phone, userId } = await createUser();
      await registerDonor(userId, registration(), { requestId: "t" });

      await say(phone, "pause");
      expect(await lastReply(phone)).toMatch(/paused/);
      expect((await getDonorOverview(userId)).profile?.notifications.status).toBe("paused");
      await say(phone, "STATUS");
      expect(await lastReply(phone)).toMatch(/Emergency alerts: Paused/);
      await say(phone, "resume");
      expect((await getDonorOverview(userId)).profile?.notifications.status).toBe("active");

      // Casual messages get the menu at most once a day.
      await say(phone, "thanks!");
      await say(phone, "ok");
      expect((await repliesTo(phone)).filter((r) => r.body?.startsWith("MarutiX coordinates")).length).toBe(1);
    });

    it("captures the number from WhatsApp and shows the profile after website sign-in with that number", async () => {
      const phone = randomPhone();
      await say(phone, "REGISTER");
      const intro = (await repliesTo(phone)).at(-2)?.body ?? "";
      expect(intro).toMatch(/We'll use this WhatsApp number \(\+91 7\dXXX XX\d{3}\)/);
      for (const t of ["Kiran Rao", "B-", "Pune", "Kothrud", "skip", "skip", "2", "no", "yes"]) await say(phone, t);
      expect(await lastReply(phone)).toMatch(/You're registered, Kiran/);

      // Later, the donor signs in on the website with an OTP to the same number.
      const { user, created } = await findOrCreateVerifiedUser(phone, phoneLookupToken(phone));
      expect(created).toBe(false);
      const overview = await getDonorOverview(user._id);
      expect(overview.profile).toMatchObject({ name: "Kiran Rao", bloodGroup: "B-", registeredVia: "whatsapp", availableForRequests: false });
      expect(overview.profile?.notifications.status).toBe("not_enabled");
      expect(await User.countDocuments({ phoneLookup: phoneLookupToken(phone) })).toBe(1);
    });

    it("UPDATE changes one detail at a time through the same validation", async () => {
      const { phone, userId } = await createUser();
      await registerDonor(userId, registration({ notificationConsent: false }), { requestId: "t" });

      await say(phone, "UPDATE");
      expect(await lastReply(phone)).toMatch(/What would you like to update\?/);
      await say(phone, "2");
      await say(phone, "zz");
      expect(await lastReply(phone)).toMatch(/didn't recognise/);
      await say(phone, "AB+");
      expect((await repliesTo(phone)).at(-2)?.body).toMatch(/Your details are updated/);

      await say(phone, "update");
      await say(phone, "3");
      await say(phone, "Varanasi");
      expect(await lastReply(phone)).toMatch(/locality or area in Varanasi/);
      await say(phone, "Assi Ghat");

      await say(phone, "UPDATE");
      await say(phone, "7");
      await say(phone, "yes");

      const view = (await getDonorOverview(userId)).profile!;
      expect(view).toMatchObject({ bloodGroup: "AB+", city: "Varanasi", locality: "Assi Ghat", name: "Asha Verma" });
      expect(view.notifications.status).toBe("active");
      expect(await ConsentRecord.countDocuments({ userId, action: "granted", source: "whatsapp" })).toBe(1);

      await say(phone, "UPDATE");
      await say(phone, "cancel");
      expect(await lastReply(phone)).toBe("No changes were made.");
    });

    it("UPDATE and PAUSE need a registration first", async () => {
      const phone = randomPhone();
      await say(phone, "UPDATE");
      expect(await lastReply(phone)).toMatch(/not registered as a donor yet/);
      await say(phone, "PAUSE");
      expect(await lastReply(phone)).toMatch(/Reply REGISTER/);
    });

    it("STOP disables all future donor notifications immediately", async () => {
      const { phone, userId } = await createUser();
      await registerDonor(userId, registration(), { requestId: "t" });
      await say(phone, "STOP");

      const view = (await getDonorOverview(userId)).profile!;
      expect(view.notifications.status).toBe("opted_out");
      const request = await createActiveRequest();
      const alert = await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: userId, summary: alertSummaryFor(request) });
      expect(alert).toMatchObject({ outcome: "suppressed", reason: "OPTED_OUT" });
    });

    it("accepts a shared WhatsApp location", async () => {
      const phone = randomPhone();
      for (const t of ["join", "Neha", "A-", "Delhi", "Saket"]) await say(phone, t);
      await handleInboundMessage({ providerMessageId: `loc-${randomUUID()}`, fromE164: phone, input: { type: "location", latitude: 28.52437, longitude: 77.20651 } });
      expect(await lastReply(phone)).toMatch(/last donate/);
    });
  });

  describe("when WhatsApp is disconnected", () => {
    it("keeps replies queued, then sends conversational replies before proactive messages", async () => {
      await NotificationEvent.deleteMany({});
      const phone = randomPhone();
      await say(phone, "join"); // 2 bot replies queued while nothing sends
      await queueAdminTestMessage({ phoneE164: "+919000000001", text: "pilot test", adminUserId: new Types.ObjectId(), idempotencyKey: randomUUID(), requestId: "t" });
      expect(await NotificationEvent.countDocuments({ status: "queued" })).toBe(3);

      const sent: string[] = [];
      const provider: MessagingProvider = {
        name: "whatsapp_web",
        isReady: () => true,
        async sendText(_phone, body) {
          sent.push(body);
          return { providerMessageId: `wamid-${randomUUID()}` };
        },
      };
      const options = { maxMessagesPerHour: 30, maxRepliesPerHour: 300, testRecipients: getWhatsAppWebConfig().testRecipients };
      for (let i = 0; i < 3; i++) await dispatchNext(provider, options);
      expect(sent[0]).toMatch(/Welcome to MarutiX/);
      expect(sent[2]).toBe("pilot test");
    });

    it("caps proactive messages without blocking conversational replies", async () => {
      await NotificationEvent.deleteMany({});
      await queueAdminTestMessage({ phoneE164: "+919000000001", text: "a", adminUserId: new Types.ObjectId(), idempotencyKey: randomUUID(), requestId: "t" });
      await queueAdminTestMessage({ phoneE164: "+919000000001", text: "b", adminUserId: new Types.ObjectId(), idempotencyKey: randomUUID(), requestId: "t" });
      const provider: MessagingProvider = { name: "whatsapp_web", isReady: () => true, sendText: async () => ({ providerMessageId: `w-${randomUUID()}` }) };
      const options = { maxMessagesPerHour: 1, maxRepliesPerHour: 300, testRecipients: getWhatsAppWebConfig().testRecipients };
      expect(await dispatchNext(provider, options)).toBe("sent");
      expect(await dispatchNext(provider, options)).toBe("rate_limited");
      await say(randomPhone(), "join");
      expect(await dispatchNext(provider, options)).toBe("sent"); // reply still flows
    });
  });
});
