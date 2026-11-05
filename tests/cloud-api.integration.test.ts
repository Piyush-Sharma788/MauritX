import { randomBytes, randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/v1/webhooks/whatsapp/route";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppCloudConfig, resetWhatsAppCloudConfigForTests } from "@/lib/whatsapp/cloud-config";
import { CloudApiMessagingProvider } from "@/server/messaging/cloud-provider";
import { signatureFor } from "@/server/messaging/cloud-webhook";
import { dispatchNext } from "@/server/messaging/dispatcher";
import { activeProvider, enqueueMessage, queueEmergencyRequestNotification } from "@/server/messaging/queue";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { OtpChallenge } from "@/server/models/otp-challenge";
import { Session } from "@/server/models/session";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";
import { whatsAppOtpProvider } from "@/server/otp-delivery";
import { requestOtp } from "@/server/services/otp";
import { createSession, findSessionUser, revokeAllSessions } from "@/server/services/session";
import { alertSummaryFor, createActiveRequest, randomMobile } from "./helpers/fixtures";

/**
 * WhatsApp Cloud API provider, webhooks, OTP delivery tracking and session
 * hardening against MongoDB. The Graph API is a mocked fetch; nothing is
 * sent to Meta.
 * Enable with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test npm test
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);
const PHONE_NUMBER_ID = "109876543210987";
const APP_SECRET = randomBytes(24).toString("hex");
const VERIFY_TOKEN = randomBytes(16).toString("hex");
const CLOUD_ENV = {
  MESSAGING_PROVIDER: "whatsapp_cloud",
  WHATSAPP_ACCESS_TOKEN: "test-access-token",
  WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  WHATSAPP_TEMPLATE_EMERGENCY_ALERT: "marutix_emergency_alert",
  WHATSAPP_TEMPLATE_REQUEST_CONFIRMATION: "marutix_request_confirmation",
};
const MIN = 60_000;

/** A Graph API stand-in: records each request and answers from a script. */
function mockGraph(answer: (body: Record<string, unknown>) => Response | Promise<Response> = () => ok()) {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(body);
    return answer(body);
  }));
  return calls;
}
const ok = (id = `wamid.${randomUUID()}`) => new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 });
const graphError = (status: number, code: number) => new Response(JSON.stringify({ error: { code, message: "x" } }), { status });

const options = { maxMessagesPerHour: 1000, maxRepliesPerHour: 1000, testRecipients: new Set<string>() };
async function drain(provider: CloudApiMessagingProvider, now = new Date()) {
  for (let i = 0; i < 50; i++) {
    const r = await dispatchNext(provider, options, now);
    if (r === "idle" || r === "rate_limited") return;
  }
}

function webhookRequest(payload: unknown, signature: string | null = null) {
  const raw = JSON.stringify(payload);
  return new NextRequest("http://localhost:3000/api/v1/webhooks/whatsapp", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? signatureFor(raw, APP_SECRET) },
  });
}
const change = (value: Record<string, unknown>, phoneNumberId = PHONE_NUMBER_ID) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919000000000", phone_number_id: phoneNumberId }, ...value } }] }],
});
const textFrom = (phoneE164: string, text: string, id = `wamid.in.${randomUUID()}`) =>
  change({ contacts: [{ wa_id: phoneE164.slice(1) }], messages: [{ from: phoneE164.slice(1), id, timestamp: "1793860000", type: "text", text: { body: text } }] });
const statusOf = (id: string, status: string, errors?: { code: number }[]) =>
  change({ statuses: [{ id, status, timestamp: "1793860000", recipient_id: "919876543210", ...(errors ? { errors } : {}) }] });

async function consentedDonor() {
  const phone = randomMobile("7");
  const user = await User.create({ phoneLookup: phoneLookupToken(phone), phoneEncrypted: encryptPii(phone), phoneVerifiedAt: new Date(), role: "donor", status: "active", displayName: "Cloud Donor" });
  await DonorProfile.create({ userId: user._id, bloodGroup: "B+", city: "Prayagraj", locality: "Civil Lines", registeredVia: "whatsapp", registeredAt: new Date(), availableForRequests: true, notificationConsentAt: new Date(), notificationChannels: ["whatsapp"] });
  return { phone, userId: user._id };
}

describe.skipIf(!enabled)("WhatsApp Cloud API, OTP tracking and sessions (MongoDB, mocked Graph API)", () => {
  const saved: Record<string, string | undefined> = {};
  let provider: CloudApiMessagingProvider;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(CLOUD_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    resetWhatsAppCloudConfigForTests();
    provider = new CloudApiMessagingProvider(getWhatsAppCloudConfig()!);
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all([NotificationEvent, WhatsAppInboundMessage, User, DonorProfile, EmergencyRequest, MessagingOptOut, OtpChallenge, Session, WhatsAppConversation].map((m) => m.syncIndexes()));
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetWhatsAppCloudConfigForTests();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("webhook security", () => {
    it("completes the subscription handshake only with the verify token", async () => {
      const good = await GET(new NextRequest(`http://localhost:3000/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`));
      expect(good.status).toBe(200);
      expect(await good.text()).toBe("1158201444");
      const bad = await GET(new NextRequest("http://localhost:3000/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"));
      expect(bad.status).toBe(403);
    });

    it("rejects unsigned or tampered payloads without processing them", async () => {
      const phone = randomMobile("9");
      const forged = await POST(webhookRequest(textFrom(phone, "STOP"), `sha256=${"0".repeat(64)}`));
      expect(forged.status).toBe(401);
      const signedForOther = signatureFor(JSON.stringify(textFrom(phone, "hi")), APP_SECRET);
      expect((await POST(webhookRequest(textFrom(phone, "STOP"), signedForOther))).status).toBe(401);
      expect(await MessagingOptOut.exists({ phoneLookup: phoneLookupToken(phone) })).toBeNull();
      expect(await WhatsAppInboundMessage.countDocuments()).toBe(0);
    });

    it("ignores events for another phone number and acknowledges unrecognised signed payloads", async () => {
      const phone = randomMobile("9");
      expect((await POST(webhookRequest(change({ messages: [{ from: phone.slice(1), id: "w-other", type: "text", text: { body: "hi" } }] }, "999999")))).status).toBe(200);
      expect(await WhatsAppInboundMessage.countDocuments()).toBe(0);
      expect((await POST(webhookRequest({ object: "page", entry: [] }))).status).toBe(200);
    });
  });

  describe("inbound messages through the existing pipeline", () => {
    it("starts the bot, replies through the Cloud outbox in the 24-hour window, and ignores redelivery", async () => {
      const phone = randomMobile("9");
      const payload = textFrom(phone, "REGISTER", "wamid.in.dup-1");
      expect((await POST(webhookRequest(payload))).status).toBe(200);
      expect((await POST(webhookRequest(payload))).status).toBe(200); // Meta redelivers
      expect(await WhatsAppConversation.countDocuments({ phoneLookup: phoneLookupToken(phone), status: "active" })).toBe(1);
      const replies = await NotificationEvent.find({ recipientLookup: phoneLookupToken(phone) }).lean();
      expect(replies.length).toBe(2); // intro + first question, once
      expect(replies.every((r) => r.provider === "whatsapp_cloud")).toBe(true);

      const calls = mockGraph();
      await drain(provider);
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.type === "text" && c.to === phone.slice(1))).toBe(true);
      expect(await NotificationEvent.countDocuments({ recipientLookup: phoneLookupToken(phone), status: "sent", bodyEncrypted: { $exists: false } })).toBe(2);
    });

    it("honours STOP immediately", async () => {
      const phone = randomMobile("9");
      await POST(webhookRequest(textFrom(phone, "STOP")));
      expect(await MessagingOptOut.exists({ phoneLookup: phoneLookupToken(phone) })).not.toBeNull();
    });
  });

  describe("outbound through the Cloud provider", () => {
    it("queues new messages for the configured provider", () => {
      expect(activeProvider()).toBe("whatsapp_cloud");
    });

    it("sends emergency alerts as the approved template outside the window, with flattened values", async () => {
      const donor = await consentedDonor();
      const request = await createActiveRequest();
      await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: { ...alertSummaryFor(request), distanceKm: 2.4 } });
      const calls = mockGraph();
      await drain(provider);
      expect(calls).toHaveLength(1);
      const template = calls[0].template as { name: string; components: { parameters: { text: string }[] }[] };
      expect(calls[0].type).toBe("template");
      expect(template.name).toBe("marutix_emergency_alert");
      const values = template.components[0].parameters.map((p) => p.text);
      expect(values).toEqual(["B+", "Packed red cells (PRBC)", "2", "City Hospital", "Civil Lines, Prayagraj", "about 2 km away", expect.stringMatching(/IST$/), request.publicRequestId]);
      expect(values.join(" ")).not.toMatch(/S\. D\.|Rohit/);
      const sent = await NotificationEvent.findOne({ recipientUserId: donor.userId }).lean();
      expect(sent).toMatchObject({ status: "sent" });
      expect(sent?.templateParamsEncrypted).toBeUndefined();
    });

    it("never sends free text outside the window when the kind has no template", async () => {
      const phone = randomMobile("9");
      const request = await createActiveRequest();
      await enqueueMessage({ kind: "requester_update", templateName: "requester_update", phoneE164: phone, body: "Update", idempotencyKey: randomUUID(), requestId: request._id.toString(), recordSuppressed: true });
      const calls = mockGraph();
      await drain(provider);
      expect(calls).toHaveLength(0);
      expect(await NotificationEvent.findOne({ recipientLookup: phoneLookupToken(phone) }).lean()).toMatchObject({ status: "failed", failureCode: "OUTSIDE_SERVICE_WINDOW" });
    });

    it("retries Graph 5xx with backoff, but never a timeout or a window rejection", async () => {
      const a = await consentedDonor();
      const b = await consentedDonor();
      const c = await consentedDonor();
      const request = await createActiveRequest();
      for (const d of [a, b, c]) await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: d.userId, summary: alertSummaryFor(request) });

      let serverErrors = 1;
      const calls = mockGraph((body) => {
        if (body.to === a.phone.slice(1) && serverErrors-- > 0) return graphError(503, 2);
        if (body.to === b.phone.slice(1)) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        if (body.to === c.phone.slice(1)) return graphError(400, 131047);
        return ok("wamid.retried");
      });
      const t0 = new Date();
      await drain(provider, t0);
      await drain(provider, new Date(t0.getTime() + 2 * MIN)); // after the first backoff
      const state = async (userId: Types.ObjectId) => NotificationEvent.findOne({ recipientUserId: userId }).lean();
      expect(await state(a.userId)).toMatchObject({ status: "sent", providerMessageId: "wamid.retried", attempts: 2 });
      expect(await state(b.userId)).toMatchObject({ status: "failed", failureCode: "SEND_TIMEOUT", attempts: 1 });
      expect(await state(c.userId)).toMatchObject({ status: "failed", failureCode: "OUTSIDE_SERVICE_WINDOW", attempts: 1 });
      expect(calls.filter((x) => x.to === b.phone.slice(1))).toHaveLength(1);
    });

    it("re-checks consent at send time and never calls Meta for a donor who opted out", async () => {
      const donor = await consentedDonor();
      const request = await createActiveRequest();
      await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(request) });
      await POST(webhookRequest(textFrom(donor.phone, "STOP")));
      const calls = mockGraph();
      await drain(provider);
      expect(calls.filter((x) => x.to === donor.phone.slice(1) && x.type === "template")).toHaveLength(0);
    });
  });

  describe("delivery status callbacks", () => {
    it("moves sent → delivered → read, never backwards, and records asynchronous failures with Meta's code", async () => {
      const a = await consentedDonor();
      const b = await consentedDonor();
      const request = await createActiveRequest();
      for (const d of [a, b]) await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: d.userId, summary: alertSummaryFor(request) });
      mockGraph((body) => ok(body.to === a.phone.slice(1) ? "wamid.A" : "wamid.B"));
      await drain(provider);
      for (const s of ["delivered", "read", "delivered"]) await POST(webhookRequest(statusOf("wamid.A", s)));
      await POST(webhookRequest(statusOf("wamid.B", "failed", [{ code: 131026 }])));
      const docA = await NotificationEvent.findOne({ providerMessageId: "wamid.A" }).lean();
      expect(docA).toMatchObject({ status: "read" });
      expect(docA?.deliveredAt).toBeInstanceOf(Date);
      expect(await NotificationEvent.findOne({ providerMessageId: "wamid.B" }).lean()).toMatchObject({ status: "failed", failureCode: "CLOUD_131026" });
    });

    it("tracks sign-in code delivery from the Cloud API", async () => {
      mockGraph(() => ok("wamid.OTP-1"));
      const phone = randomMobile("9");
      const otp = whatsAppOtpProvider({ accessToken: "t", phoneNumberId: PHONE_NUMBER_ID, graphApiVersion: "v26.0", templateName: "marutix_login_code", languageCode: "en" });
      const result = await requestOtp({ phoneE164: phone, purpose: "login" }, { requestId: randomUUID(), ip: "203.0.113.5", userAgent: "vitest" }, otp);
      expect(result.channel).toBe("whatsapp");
      expect(await OtpChallenge.findOne({ phoneLookup: phoneLookupToken(phone) }).lean()).toMatchObject({ providerMessageId: "wamid.OTP-1", deliveryStatus: "accepted" });
      await POST(webhookRequest(statusOf("wamid.OTP-1", "delivered")));
      expect(await OtpChallenge.findOne({ providerMessageId: "wamid.OTP-1" }).lean()).toMatchObject({ deliveryStatus: "delivered" });
      // Code values never appear in stored records.
      const raw = JSON.stringify(await OtpChallenge.collection.findOne({}));
      expect(raw).not.toMatch(/"code"/);
    });

    it("tells the user plainly when Meta can't deliver a sign-in code", async () => {
      mockGraph(() => graphError(400, 131026));
      const otp = whatsAppOtpProvider({ accessToken: "t", phoneNumberId: PHONE_NUMBER_ID, graphApiVersion: "v26.0", templateName: "marutix_login_code", languageCode: "en" });
      const error = await requestOtp({ phoneE164: randomMobile("9"), purpose: "login" }, { requestId: randomUUID(), ip: "203.0.113.6", userAgent: "vitest" }, otp).then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ code: "OTP_DELIVERY_FAILED", status: 503 });
      expect(await OtpChallenge.countDocuments()).toBe(0);
    });
  });

  describe("session hardening", () => {
    async function userWithRole(role: "donor" | "admin") {
      const phone = randomMobile("9");
      return User.create({ phoneLookup: phoneLookupToken(phone), phoneEncrypted: encryptPii(phone), phoneVerifiedAt: new Date(), role, status: "active" });
    }

    it("expires idle sessions, and admin sessions sooner and at an absolute limit", async () => {
      const donor = await userWithRole("donor");
      const admin = await userWithRole("admin");
      const d = await createSession(donor._id);
      const a = await createSession(admin._id);
      const t = Date.now();
      expect(await findSessionUser(d.token, new Date(t + 60 * MIN))).not.toBeNull();
      expect(await findSessionUser(a.token, new Date(t + 60 * MIN))).not.toBeNull();
      // Two idle hours end an admin session but not a donor's.
      expect(await findSessionUser(a.token, new Date(t + 60 * MIN + 121 * MIN))).toBeNull();
      expect(await findSessionUser(d.token, new Date(t + 60 * MIN + 121 * MIN))).not.toBeNull();
      expect(await Session.findOne({ userId: admin._id }).lean()).toMatchObject({ revokedReason: "idle" });

      // An active admin still has to sign in again after 12 hours.
      const busy = await createSession(admin._id);
      for (let h = 1; h <= 11; h++) expect(await findSessionUser(busy.token, new Date(t + h * 60 * MIN))).not.toBeNull();
      expect(await findSessionUser(busy.token, new Date(t + 12.5 * 60 * MIN))).toBeNull();
      expect(await Session.findOne({ tokenHash: { $exists: true }, userId: admin._id, revokedReason: "max_age" }).lean()).not.toBeNull();

      // Three idle days end a donor session.
      expect(await findSessionUser(d.token, new Date(t + 5 * 24 * 60 * MIN))).toBeNull();
    });

    it("signs a user out everywhere on a role or phone change, optionally keeping the current session", async () => {
      const user = await userWithRole("donor");
      const here = await createSession(user._id);
      const other = await createSession(user._id);
      expect(await revokeAllSessions(user._id, "phone_changed", here.token)).toBe(1);
      expect(await findSessionUser(here.token)).not.toBeNull();
      expect(await findSessionUser(other.token)).toBeNull();
      await revokeAllSessions(user._id, "role_changed");
      expect(await findSessionUser(here.token)).toBeNull();
    });
  });

  it("keeps the previous provider's messages with that provider", async () => {
    await NotificationEvent.create({
      channel: "whatsapp", provider: "whatsapp_web", kind: "bot_reply", templateName: "bot_reply", recipientLookup: "x", recipientPhoneEncrypted: encryptPii("+919000000001"),
      bodyEncrypted: encryptPii("hi"), idempotencyKey: randomUUID(), priority: 0, nextAttemptAt: new Date(), expiresAt: new Date(Date.now() + 60 * MIN), status: "queued",
    });
    const calls = mockGraph();
    await drain(provider);
    expect(calls).toHaveLength(0);
    expect(decryptPii((await NotificationEvent.findOne({ provider: "whatsapp_web" }).lean())!.bodyEncrypted!)).toBe("hi");
  });
});
