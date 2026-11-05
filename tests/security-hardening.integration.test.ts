import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as alertsPost } from "@/app/api/v1/admin/requests/[publicRequestId]/alerts/route";
import { GET as coordinationGet } from "@/app/api/v1/admin/requests/[publicRequestId]/coordination/route";
import { POST as matchingPost } from "@/app/api/v1/admin/requests/[publicRequestId]/matching/route";
import { POST as sendMessagePost } from "@/app/api/v1/admin/whatsapp/send-message/route";
import { POST as otpRequestPost } from "@/app/api/v1/auth/otp/request/route";
import { connectToDatabase } from "@/lib/db/mongoose";
import { encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { AuditLog } from "@/server/models/audit-log";
import { RateLimitBucket } from "@/server/models/rate-limit-bucket";
import { RequestResponse } from "@/server/models/request-response";
import { Session } from "@/server/models/session";
import { User } from "@/server/models/user";
import { ADMIN_RATE_LIMITS } from "@/server/services/rate-limit";
import { createSession, findSession, sessionCookieName } from "@/server/services/session";
import { createActiveRequest, randomMobile } from "./helpers/fixtures";

/**
 * Security hardening against MongoDB: per-admin limits on endpoints that
 * message donors or fan out over many records, audit of admin reads of donor
 * phone numbers, and OTP responses that don't reveal whether a number is registered.
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);
const BASE = "http://localhost:3000";

let cookieToken: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookieToken && name === sessionCookieName() ? { name, value: cookieToken } : undefined) }),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const json = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${BASE}${path}`, { method, headers: { origin: BASE, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } | null }).error?.code;

/** A staff user whose session already passed the second factor. */
async function verifiedAdmin(role: "coordinator" | "super_admin" = "super_admin") {
  const phone = randomMobile("7");
  const user = await User.create({ phoneLookup: phoneLookupToken(phone), phoneEncrypted: encryptPii(phone), phoneVerifiedAt: new Date(), role, displayName: "Staff Member", mfa: { enabledAt: new Date(), secretEncrypted: encryptPii("JBSWY3DPEHPK3PXP"), recoveryCodeHashes: [] } });
  const { token } = await createSession(user._id);
  const found = await findSession(token);
  await Session.updateOne({ _id: found!.session.id }, { $set: { mfaVerifiedAt: new Date() } });
  return { user, token };
}

describe.skipIf(!enabled)("security hardening (MongoDB)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
  });
  beforeEach(async () => {
    cookieToken = undefined;
    await RateLimitBucket.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  describe("per-admin limits on expensive endpoints", () => {
    it("caps test messages per admin, before any work is done", async () => {
      const admin = await verifiedAdmin();
      cookieToken = admin.token;
      // No Idempotency-Key: each call is refused after the limit check, so nothing is queued.
      for (let i = 0; i < ADMIN_RATE_LIMITS.testMessage.limit; i++) {
        const res = await sendMessagePost(json("/api/v1/admin/whatsapp/send-message", "POST", { phone: "+919000000001", text: "hi" }), params());
        expect(await errorCode(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      }
      const blocked = await sendMessagePost(json("/api/v1/admin/whatsapp/send-message", "POST", { phone: "+919000000001", text: "hi" }), params());
      expect(blocked.status).toBe(429);
      expect(await errorCode(blocked)).toBe("RATE_LIMITED");
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

      // Another admin has their own allowance.
      const other = await verifiedAdmin();
      cookieToken = other.token;
      const res = await sendMessagePost(json("/api/v1/admin/whatsapp/send-message", "POST", { phone: "+919000000001", text: "hi" }), params());
      expect(await errorCode(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("caps donor searches and alert batches per admin", async () => {
      const admin = await verifiedAdmin("coordinator");
      cookieToken = admin.token;
      const missing = { publicRequestId: "MX-ZZZZ-9999" };
      for (let i = 0; i < ADMIN_RATE_LIMITS.matching.limit; i++) {
        expect((await matchingPost(json("/api/v1/admin/requests/x/matching", "POST", { radiusKm: 10 }), params(missing))).status).not.toBe(429);
      }
      expect(await errorCode(await matchingPost(json("/api/v1/admin/requests/x/matching", "POST", { radiusKm: 10 }), params(missing)))).toBe("RATE_LIMITED");

      for (let i = 0; i < ADMIN_RATE_LIMITS.alerts.limit; i++) {
        expect((await alertsPost(json("/api/v1/admin/requests/x/alerts", "POST", { matchingRunId: "0123456789abcdef01234567" }), params(missing))).status).not.toBe(429);
      }
      expect(await errorCode(await alertsPost(json("/api/v1/admin/requests/x/alerts", "POST", { matchingRunId: "0123456789abcdef01234567" }), params(missing)))).toBe("RATE_LIMITED");
    });

    it("does not count requests from people who aren't verified admins", async () => {
      const phone = randomMobile("7");
      const donor = await User.create({ phoneLookup: phoneLookupToken(phone), phoneEncrypted: encryptPii(phone), phoneVerifiedAt: new Date(), role: "donor" });
      cookieToken = (await createSession(donor._id)).token;
      const res = await sendMessagePost(json("/api/v1/admin/whatsapp/send-message", "POST", { phone: "+919000000001", text: "hi" }), params());
      expect(res.status).toBe(403);
      expect(await RateLimitBucket.countDocuments({})).toBe(0);
    });
  });

  describe("admin reads of donor contact details", () => {
    it("audits the coordination view when it shows consenting donors' numbers, and not otherwise", async () => {
      const admin = await verifiedAdmin("coordinator");
      cookieToken = admin.token;
      const request = await createActiveRequest();
      const route = params({ publicRequestId: request.publicRequestId });

      const empty = await coordinationGet(json(`/api/v1/admin/requests/${request.publicRequestId}/coordination`, "GET"), route);
      expect(empty.status).toBe(200);
      expect(await AuditLog.countDocuments({ action: "donor_contact.viewed_by_admin" })).toBe(0);

      const donorPhone = randomMobile("9");
      const donor = await User.create({ phoneLookup: phoneLookupToken(donorPhone), phoneEncrypted: encryptPii(donorPhone), phoneVerifiedAt: new Date(), role: "donor", displayName: "Meera Singh" });
      const declinedPhone = randomMobile("9");
      const declined = await User.create({ phoneLookup: phoneLookupToken(declinedPhone), phoneEncrypted: encryptPii(declinedPhone), phoneVerifiedAt: new Date(), role: "donor", displayName: "Ravi Das" });
      await RequestResponse.create({ requestId: request._id, donorUserId: donor._id, response: "interested", respondedAt: new Date(), contactSharingConsentAt: new Date() });
      await RequestResponse.create({ requestId: request._id, donorUserId: declined._id, response: "interested", respondedAt: new Date(), contactSharingDeclinedAt: new Date() });

      const res = await coordinationGet(json(`/api/v1/admin/requests/${request.publicRequestId}/coordination`, "GET"), route);
      const body = (await res.json()) as { data: { responses: { donorPhone: string | null; contactSharing: string }[] } };
      const phones = body.data.responses.map((r) => r.donorPhone);
      // Only the donor who said YES is disclosed.
      expect(phones).toContain(donorPhone);
      expect(phones).not.toContain(declinedPhone);

      const audit = await AuditLog.find({ action: "donor_contact.viewed_by_admin" }).lean();
      expect(audit).toHaveLength(1);
      expect(audit[0].actorUserId?.toString()).toBe(admin.user._id.toString());
      expect(audit[0].resourceId).toBe(`${request.publicRequestId}:1`);
      expect(JSON.stringify(audit[0])).not.toContain(donorPhone.slice(-10));
    });
  });

  describe("sign-in codes don't reveal registration", () => {
    it("answers identically for a registered and an unknown number", async () => {
      const registered = randomMobile("8");
      await User.create({ phoneLookup: phoneLookupToken(registered), phoneEncrypted: encryptPii(registered), phoneVerifiedAt: new Date(), role: "donor" });
      const unknown = randomMobile("8");
      const shape = async (phone: string) => {
        const res = await otpRequestPost(json("/api/v1/auth/otp/request", "POST", { phone, purpose: "login" }, { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` }), params());
        const body = (await res.json()) as { data: Record<string, unknown> };
        return { status: res.status, keys: Object.keys(body.data).sort(), channel: body.data.channel };
      };
      expect(await shape(registered)).toEqual(await shape(unknown));
    });
  });
});
