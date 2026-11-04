import { randomInt, randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { dispatchNext, MAX_SEND_ATTEMPTS, recordDeliveryAck } from "@/server/messaging/dispatcher";
import { handleInboundMessage } from "@/server/messaging/inbound";
import { listRecentMessages } from "@/server/messaging/message-log";
import { MessagingError, type MessagingProvider } from "@/server/messaging/provider";
import { queueAdminTestMessage, queueEmergencyRequestNotification } from "@/server/messaging/queue";
import { DonorProfile } from "@/server/models/donor-profile";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { User } from "@/server/models/user";
import { WhatsAppConnection } from "@/server/models/whatsapp-connection";
import { acquireLease, LEASE_TTL_MS, releaseLease, renewLease } from "@/server/whatsapp/connection-store";

/**
 * Messaging foundation against MongoDB with a fake provider (no WhatsApp).
 * Enable with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test npm test
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);

const TEST_RECIPIENT = "+919000000001";
const randomPhone = () => `+918${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
const admin = new Types.ObjectId();

function fakeProvider(behaviour: (phone: string, body: string) => Promise<{ providerMessageId: string }> = async () => ({ providerMessageId: `wamid-${randomUUID()}` })) {
  const sent: { phone: string; body: string }[] = [];
  const provider: MessagingProvider = {
    name: "whatsapp_web",
    isReady: () => true,
    async sendText(phone, body) {
      const result = await behaviour(phone, body);
      sent.push({ phone, body });
      return result;
    },
  };
  return { provider, sent };
}

const inbound = (phone: string, text: string) =>
  handleInboundMessage({ providerMessageId: `m-${randomUUID()}`, fromE164: phone, input: { type: "text", text } });

const options = () => ({ maxMessagesPerHour: 1000, maxRepliesPerHour: 1000, testRecipients: getWhatsAppWebConfig().testRecipients });

async function createDonor(opts: { consent?: boolean; available?: boolean } = {}) {
  const phone = randomPhone();
  const user = await User.create({
    phoneLookup: phoneLookupToken(phone),
    phoneEncrypted: encryptPii(phone),
    phoneVerifiedAt: new Date(),
    role: "donor",
    status: "active",
  });
  await DonorProfile.create({
    userId: user._id,
    bloodGroup: "B+",
    city: "Prayagraj",
    locality: "Civil Lines",
    registeredVia: "web",
    registeredAt: new Date(),
    availableForRequests: opts.available ?? true,
    notificationConsentAt: opts.consent === false ? undefined : new Date(),
    notificationChannels: opts.consent === false ? [] : ["whatsapp"],
  });
  return { phone, userId: user._id };
}

const summary = (overrides: Record<string, unknown> = {}) => ({
  area: "Civil Lines, Prayagraj",
  bloodGroup: "B+" as const,
  component: "packed_red_cells" as const,
  neededBy: new Date("2026-11-05T06:30:00Z"),
  secureLink: "http://localhost:3000/r/abc123",
  ...overrides,
});

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe.skipIf(!enabled)("Messaging foundation (MongoDB, fake provider)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all([NotificationEvent.syncIndexes(), User.syncIndexes(), MessagingOptOut.syncIndexes(), DonorProfile.syncIndexes()]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await NotificationEvent.deleteMany({});
  });

  describe("queueing rules", () => {
    it("queues admin tests to allow-listed numbers, encrypted, and deduplicates by idempotency key", async () => {
      const key = randomUUID();
      const first = await queueAdminTestMessage({ phoneE164: TEST_RECIPIENT, text: "Pilot test", adminUserId: admin, idempotencyKey: key, requestId: "t" });
      const again = await queueAdminTestMessage({ phoneE164: TEST_RECIPIENT, text: "Pilot test", adminUserId: admin, idempotencyKey: key, requestId: "t" });

      expect(first).toMatchObject({ status: "queued", duplicate: false });
      expect(again).toMatchObject({ messageId: first.messageId, duplicate: true });
      expect(await NotificationEvent.countDocuments()).toBe(1);

      const raw = JSON.stringify(await NotificationEvent.collection.findOne({}));
      expect(raw).not.toContain("Pilot test");
      expect(raw).not.toContain("9000000001");
    });

    it("refuses admin tests to numbers that are neither allow-listed nor consented", async () => {
      await expectAppError(
        queueAdminTestMessage({ phoneE164: randomPhone(), text: "hi", adminUserId: admin, idempotencyKey: randomUUID(), requestId: "t" }),
        "RECIPIENT_NOT_ALLOWED",
      );
      const { phone } = await createDonor({ consent: false });
      await expectAppError(
        queueAdminTestMessage({ phoneE164: phone, text: "hi", adminUserId: admin, idempotencyKey: randomUUID(), requestId: "t" }),
        "RECIPIENT_NOT_ALLOWED",
      );
      expect(await NotificationEvent.countDocuments()).toBe(0);
    });

    it("allows admin tests to a consented donor", async () => {
      const { phone } = await createDonor();
      const result = await queueAdminTestMessage({ phoneE164: phone, text: "hi", adminUserId: admin, idempotencyKey: randomUUID(), requestId: "t" });
      expect(result.status).toBe("queued");
    });

    it("notifies a consented, available donor once per request", async () => {
      const { userId } = await createDonor();
      const requestId = randomUUID();
      const first = await queueEmergencyRequestNotification({ requestId, donorUserId: userId, summary: summary() });
      const second = await queueEmergencyRequestNotification({ requestId, donorUserId: userId, summary: summary() });
      expect(first.outcome).toBe("queued");
      expect(second).toMatchObject({ outcome: "duplicate", messageId: first.messageId });
      expect(await NotificationEvent.countDocuments({ requestId })).toBe(1);
    });

    it("records a suppressed event for donors without consent or availability", async () => {
      const noConsent = await createDonor({ consent: false });
      const unavailable = await createDonor({ available: false });
      const a = await queueEmergencyRequestNotification({ requestId: randomUUID(), donorUserId: noConsent.userId, summary: summary() });
      const b = await queueEmergencyRequestNotification({ requestId: randomUUID(), donorUserId: unavailable.userId, summary: summary() });
      expect(a).toMatchObject({ outcome: "suppressed", reason: "NO_CONSENT" });
      expect(b).toMatchObject({ outcome: "suppressed", reason: "NOT_AVAILABLE" });
      expect(await NotificationEvent.countDocuments({ status: "suppressed", bodyEncrypted: { $exists: true } })).toBe(0);
    });

    it("rejects emergency links outside the app and free text in the area", async () => {
      const { userId } = await createDonor();
      await expect(
        queueEmergencyRequestNotification({ requestId: randomUUID(), donorUserId: userId, summary: summary({ secureLink: "https://evil.example/x" }) }),
      ).rejects.toThrow();
      await expect(
        queueEmergencyRequestNotification({ requestId: randomUUID(), donorUserId: userId, summary: summary({ area: "Patient: Ravi <script>" }) }),
      ).rejects.toThrow();
    });
  });

  describe("dispatcher", () => {
    const queueTest = (phone = TEST_RECIPIENT) =>
      queueAdminTestMessage({ phoneE164: phone, text: "Dispatch test", adminUserId: admin, idempotencyKey: randomUUID(), requestId: "t" });

    it("sends, records the provider id and erases the body", async () => {
      const { messageId } = await queueTest();
      const { provider, sent } = fakeProvider();
      expect(await dispatchNext(provider, options())).toBe("sent");
      expect(sent).toEqual([{ phone: TEST_RECIPIENT, body: "Dispatch test" }]);

      const doc = await NotificationEvent.findById(messageId).lean();
      expect(doc?.status).toBe("sent");
      expect(doc?.providerMessageId).toMatch(/^wamid-/);
      expect(doc?.sentAt).toBeInstanceOf(Date);
      expect(doc?.bodyEncrypted).toBeUndefined();
      expect(await dispatchNext(provider, options())).toBe("idle");
    });

    it("re-checks consent right before sending", async () => {
      const donor = await createDonor();
      const { messageId } = await queueEmergencyRequestNotification({ requestId: randomUUID(), donorUserId: donor.userId, summary: summary() }) as { messageId: string };
      await DonorProfile.updateOne({ userId: donor.userId }, { $set: { notificationConsentWithdrawnAt: new Date() } });

      const { provider, sent } = fakeProvider();
      expect(await dispatchNext(provider, options())).toBe("suppressed");
      expect(sent).toHaveLength(0);
      expect((await NotificationEvent.findById(messageId).lean())?.failureCode).toBe("NO_CONSENT");
    });

    it("fails permanently when the number isn't on WhatsApp", async () => {
      const { messageId } = await queueTest();
      const { provider } = fakeProvider(async () => {
        throw new MessagingError("NOT_ON_WHATSAPP", false);
      });
      expect(await dispatchNext(provider, options())).toBe("failed");
      const doc = await NotificationEvent.findById(messageId).lean();
      expect(doc).toMatchObject({ status: "failed", failureCode: "NOT_ON_WHATSAPP", attempts: 1 });
    });

    it("retries transient failures with backoff, then gives up", async () => {
      const { messageId } = await queueTest();
      const { provider } = fakeProvider(async () => {
        throw new MessagingError("SEND_FAILED", true);
      });
      let now = new Date();
      for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt++) {
        expect(await dispatchNext(provider, options(), now)).toBe("retry");
        const doc = await NotificationEvent.findById(messageId).lean();
        expect(doc?.status).toBe("queued");
        expect(doc!.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
        expect(await dispatchNext(provider, options(), now)).toBe("idle"); // not before backoff
        now = new Date(doc!.nextAttemptAt.getTime() + 1);
      }
      expect(await dispatchNext(provider, options(), now)).toBe("failed");
      expect((await NotificationEvent.findById(messageId).lean())?.attempts).toBe(MAX_SEND_ATTEMPTS);
    });

    it("never sends expired messages", async () => {
      const { messageId } = await queueTest();
      const { provider, sent } = fakeProvider();
      const later = new Date(Date.now() + getWhatsAppWebConfig().messageTtlMs + 1000);
      expect(await dispatchNext(provider, options(), later)).toBe("idle");
      expect(sent).toHaveLength(0);
      expect((await NotificationEvent.findById(messageId).lean())?.failureCode).toBe("EXPIRED");
    });

    it("fails (never resends) messages left mid-send by a crashed worker", async () => {
      const { messageId } = await queueTest();
      await NotificationEvent.updateOne({ _id: messageId }, { $set: { status: "sending", lockedUntil: new Date(Date.now() - 1000) } });
      const { provider, sent } = fakeProvider();
      expect(await dispatchNext(provider, options())).toBe("idle");
      expect(sent).toHaveLength(0);
      expect((await NotificationEvent.findById(messageId).lean())?.failureCode).toBe("UNKNOWN_DELIVERY_STATE");
    });

    it("enforces the hourly cap", async () => {
      await queueTest();
      await queueTest();
      const { provider, sent } = fakeProvider();
      const capped = { ...options(), maxMessagesPerHour: 1 };
      expect(await dispatchNext(provider, capped)).toBe("sent");
      expect(await dispatchNext(provider, capped)).toBe("rate_limited");
      expect(sent).toHaveLength(1);
    });

    it("moves delivery status forward only", async () => {
      const { messageId } = await queueTest();
      const { provider } = fakeProvider();
      await dispatchNext(provider, options());
      const { providerMessageId } = (await NotificationEvent.findById(messageId).lean())!;

      await recordDeliveryAck(providerMessageId!, "device");
      expect((await NotificationEvent.findById(messageId).lean())?.status).toBe("delivered");
      await recordDeliveryAck(providerMessageId!, "read");
      await recordDeliveryAck(providerMessageId!, "device");
      const doc = await NotificationEvent.findById(messageId).lean();
      expect(doc?.status).toBe("read");
      expect(doc?.deliveredAt).toBeInstanceOf(Date);
      expect(doc?.readAt).toBeInstanceOf(Date);
    });
  });

  describe("inbound keywords", () => {
    it("STOP opts out, withdraws consent, suppresses queued messages and confirms once", async () => {
      const donor = await createDonor();
      await queueEmergencyRequestNotification({ requestId: randomUUID(), donorUserId: donor.userId, summary: summary() });

      expect(await inbound(donor.phone, "  stop ")).toBe("opt_out");
      expect(await inbound(donor.phone, "STOP")).toBe("opt_out");

      expect(await MessagingOptOut.countDocuments({ phoneLookup: phoneLookupToken(donor.phone) })).toBe(1);
      expect((await DonorProfile.findOne({ userId: donor.userId }).lean())?.notificationConsentWithdrawnAt).toBeInstanceOf(Date);
      expect(await NotificationEvent.countDocuments({ kind: "emergency_request", status: "suppressed", failureCode: "OPTED_OUT" })).toBe(1);
      expect(await NotificationEvent.countDocuments({ kind: "opt_out_confirmation" })).toBe(1);

      // The confirmation is still delivered; nothing else is.
      const { provider, sent } = fakeProvider();
      expect(await dispatchNext(provider, options())).toBe("sent");
      expect(sent[0].body).toMatch(/unsubscribed/);
      await expectAppError(
        queueAdminTestMessage({ phoneE164: donor.phone, text: "hi", adminUserId: admin, idempotencyKey: randomUUID(), requestId: "t" }),
        "RECIPIENT_OPTED_OUT",
      );
    });

    it("answers HELP with the command list", async () => {
      const phone = randomPhone();
      expect(await inbound(phone, "help")).toBe("handled");
      const reply = await NotificationEvent.findOne({ recipientLookup: phoneLookupToken(phone) }).lean();
      expect(reply?.kind).toBe("bot_reply");
    });
  });

  it("lists messages with masked recipients and no bodies", async () => {
    await queueAdminTestMessage({ phoneE164: TEST_RECIPIENT, text: "secret body", adminUserId: admin, idempotencyKey: randomUUID(), requestId: "t" });
    const { messages } = await listRecentMessages({ limit: 10 });
    expect(messages[0].recipient).toBe("+91 90XXX XX001");
    expect(JSON.stringify(messages)).not.toContain("secret body");
  });

  describe("single-worker lease", () => {
    beforeEach(async () => {
      await WhatsAppConnection.deleteMany({});
    });

    it("lets only one worker hold the WhatsApp session", async () => {
      expect(await acquireLease("worker-a")).toBe(true);
      expect(await acquireLease("worker-b")).toBe(false);
      expect(await renewLease("worker-a")).toBe(true);
      expect(await renewLease("worker-b")).toBe(false);
      await releaseLease("worker-a");
      expect(await acquireLease("worker-b")).toBe(true);
    });

    it("allows takeover only after the lease expires", async () => {
      const now = new Date();
      expect(await acquireLease("worker-a", now)).toBe(true);
      expect(await acquireLease("worker-b", new Date(now.getTime() + LEASE_TTL_MS - 1000))).toBe(false);
      expect(await acquireLease("worker-b", new Date(now.getTime() + LEASE_TTL_MS + 1000))).toBe(true);
      expect(await renewLease("worker-a")).toBe(false);
    });
  });
});
