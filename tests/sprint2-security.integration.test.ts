import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as deletionPost } from "@/app/api/v1/account/deletion/route";
import { GET as auditGet } from "@/app/api/v1/admin/audit/route";
import { PATCH as settingsPatch } from "@/app/api/v1/admin/operations/settings/route";
import { GET as requestsGet } from "@/app/api/v1/admin/requests/route";
import { POST as waConnectPost } from "@/app/api/v1/admin/whatsapp/connect/route";
import { POST as enrollPost } from "@/app/api/v1/auth/mfa/enroll/route";
import { POST as verifyPost } from "@/app/api/v1/auth/mfa/verify/route";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { apiRoute } from "@/lib/api/handler";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { stepAt, totpAt } from "@/lib/security/totp";
import { retryFailedAlert } from "@/server/coordination/alerts";
import { dispatchNext } from "@/server/messaging/dispatcher";
import type { MessagingProvider } from "@/server/messaging/provider";
import { AuditLog } from "@/server/models/audit-log";
import { ConsentRecord } from "@/server/models/consent-record";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { ErrorEvent } from "@/server/models/error-event";
import { InstitutionOutreach } from "@/server/models/institution-outreach";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { OtpChallenge } from "@/server/models/otp-challenge";
import { RateLimitBucket } from "@/server/models/rate-limit-bucket";
import { RequestResponse } from "@/server/models/request-response";
import { RequestShareLink } from "@/server/models/request-share-link";
import { Session } from "@/server/models/session";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { reportError } from "@/server/monitoring/report";
import type { OtpDeliveryProvider, SmsOtpOption } from "@/server/otp-delivery";
import { deleteAccount } from "@/server/services/account-deletion";
import { confirmMfaEnrollment, resetMfa, startMfaEnrollment, verifyMfa } from "@/server/services/mfa";
import { requestOtp } from "@/server/services/otp";
import { anonymizeClosedRequests, REMOVED } from "@/server/services/retention";
import { createSession, findSession, sessionCookieName } from "@/server/services/session";
import { findOrCreateVerifiedUser } from "@/server/services/users";
import { setStaffRole } from "@/server/services/staff";
import { createActiveRequest, randomMobile } from "./helpers/fixtures";

/**
 * Sprint 2 security workflows against MongoDB: admin MFA, RBAC on real route
 * handlers, session revocation on privilege changes, account deletion,
 * retention, error monitoring and the SMS OTP fallback. SMS and webhooks use
 * mocked providers; nothing leaves the machine.
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);
const BASE = "http://localhost:3000";

// The signed-in browser: route handlers read the session cookie through next/headers.
let cookieToken: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookieToken && name === sessionCookieName() ? { name, value: cookieToken } : undefined) }),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const ctx = (ip = "203.0.113.7") => ({ requestId: randomUUID(), ip, userAgent: "vitest" });
const json = (path: string, method: string, body?: unknown) =>
  new NextRequest(`${BASE}${path}`, { method, headers: { origin: BASE, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } | null }).error?.code;

async function makeUser(role: "donor" | "coordinator" | "super_admin" | "admin" = "donor", phone = randomMobile("7")) {
  const user = await User.create({ phoneLookup: phoneLookupToken(phone), phoneEncrypted: encryptPii(phone), phoneVerifiedAt: new Date(), role, displayName: "Asha Verma" });
  const { token } = await createSession(user._id);
  const found = await findSession(token);
  return { user, phone, token, sessionId: found!.session.id.toString() };
}

/** Enrolls a staff user's authenticator and returns its secret, recovery codes and the step used. */
async function enroll(staff: Awaited<ReturnType<typeof makeUser>>, now = new Date()) {
  const { secret } = await startMfaEnrollment(staff.user._id.toString(), "label", ctx());
  const { recoveryCodes } = await confirmMfaEnrollment(staff.user._id.toString(), staff.sessionId, totpAt(secret, stepAt(now)), ctx(), now);
  return { secret, recoveryCodes, step: stepAt(now) };
}

describe.skipIf(!enabled)("Sprint 2 security workflows (MongoDB)", () => {
  beforeAll(async () => {
    await connectToDatabase();
  });
  beforeEach(async () => {
    cookieToken = undefined;
    await RateLimitBucket.deleteMany({});
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await mongoose.disconnect();
  });

  describe("admin two-factor authentication", () => {
    it("is only for staff", async () => {
      const donor = await makeUser("donor");
      await expect(startMfaEnrollment(donor.user._id.toString(), "x", ctx())).rejects.toMatchObject({ status: 403 });
    });

    it("enrolls with a valid code, stores only ciphertext and hashes, and verifies the session", async () => {
      const staff = await makeUser("coordinator");
      const { secret, recoveryCodes } = await enroll(staff);
      expect(recoveryCodes).toHaveLength(10);
      const stored = (await User.findById(staff.user._id).lean())!;
      expect(stored.mfa?.enabledAt).toBeInstanceOf(Date);
      expect(stored.mfa?.secretEncrypted).not.toContain(secret);
      expect(decryptPii(stored.mfa!.secretEncrypted!)).toBe(secret);
      expect(stored.mfa?.pendingSecretEncrypted).toBeUndefined();
      expect(stored.mfa?.recoveryCodeHashes).toHaveLength(10);
      for (const code of recoveryCodes) expect(stored.mfa?.recoveryCodeHashes).not.toContain(code);
      expect((await Session.findById(staff.sessionId).lean())?.mfaVerifiedAt).toBeInstanceOf(Date);
      expect(await AuditLog.exists({ action: "auth.mfa.enrolled", actorUserId: staff.user._id })).toBeTruthy();
      // A second enrollment can't silently replace the authenticator.
      await expect(startMfaEnrollment(staff.user._id.toString(), "x", ctx())).rejects.toMatchObject({ status: 409 });
    });

    it("rejects a wrong enrollment code", async () => {
      const staff = await makeUser("coordinator");
      const { secret } = await startMfaEnrollment(staff.user._id.toString(), "x", ctx());
      const wrong = totpAt(secret, stepAt(new Date()) + 5);
      await expect(confirmMfaEnrollment(staff.user._id.toString(), staff.sessionId, wrong, ctx())).rejects.toMatchObject({ code: "MFA_INVALID" });
      expect((await User.findById(staff.user._id).lean())?.mfa?.enabledAt).toBeUndefined();
    });

    it("refuses a replayed code, accepts the next one, and uses each recovery code once", async () => {
      const t0 = new Date(Math.floor(Date.now() / 30_000) * 30_000);
      const staff = await makeUser("super_admin");
      const { secret, recoveryCodes, step } = await enroll(staff, t0);
      const second = await createSession(staff.user._id);
      const secondId = (await findSession(second.token))!.session.id.toString();

      // The enrollment code was already used at this step.
      await expect(verifyMfa(staff.user._id.toString(), secondId, { code: totpAt(secret, step) }, ctx(), t0)).rejects.toMatchObject({ code: "MFA_INVALID" });
      const t1 = new Date(t0.getTime() + 30_000);
      await verifyMfa(staff.user._id.toString(), secondId, { code: totpAt(secret, step + 1) }, ctx(), t1);
      await expect(verifyMfa(staff.user._id.toString(), secondId, { code: totpAt(secret, step + 1) }, ctx(), t1)).rejects.toMatchObject({ code: "MFA_INVALID" });
      // Every attempt counts against the 15-minute limit; start the recovery-code part with a fresh window.
      await RateLimitBucket.deleteMany({});

      const third = await createSession(staff.user._id);
      const thirdId = (await findSession(third.token))!.session.id.toString();
      const used = await verifyMfa(staff.user._id.toString(), thirdId, { recoveryCode: recoveryCodes[0].toLowerCase() }, ctx(), t1);
      expect(used.recoveryCodesRemaining).toBe(9);
      await expect(verifyMfa(staff.user._id.toString(), thirdId, { recoveryCode: recoveryCodes[0] }, ctx(), t1)).rejects.toMatchObject({ code: "MFA_INVALID" });
      expect(await AuditLog.exists({ action: "auth.mfa.recovery_code_used", actorUserId: staff.user._id })).toBeTruthy();
    });

    it("rate-limits guessing per account, per 15 minutes and per day", async () => {
      const staff = await makeUser("coordinator");
      await enroll(staff);
      const attempts = [];
      for (let i = 0; i < 6; i++) attempts.push(await verifyMfa(staff.user._id.toString(), staff.sessionId, { code: "000000" }, ctx(`198.51.100.${i}`)).catch((e: { code: string }) => e.code));
      expect(attempts.slice(0, 4).every((c) => c === "MFA_INVALID")).toBe(true);
      expect(attempts[5]).toBe("RATE_LIMITED");

      // Across windows the daily cap still applies (20 attempts, including the enrollment code).
      const start = new Date();
      const daily = [];
      for (let i = 0; i < 25; i++) {
        const at = new Date(start.getTime() + Math.floor(i / 4) * 16 * 60_000);
        daily.push(await verifyMfa(staff.user._id.toString(), staff.sessionId, { code: "000000" }, ctx(`198.51.101.${i}`), at).catch((e: { code: string }) => e.code));
      }
      expect(daily.filter((c) => c === "MFA_INVALID").length).toBeLessThanOrEqual(20);
      expect(daily.at(-1)).toBe("RATE_LIMITED");
    });

    it("an MFA reset removes the authenticator and signs the user out everywhere", async () => {
      const staff = await makeUser("coordinator");
      await enroll(staff);
      await resetMfa(staff.user._id, randomUUID());
      expect((await User.findById(staff.user._id).lean())?.mfa).toBeUndefined();
      expect(await findSession(staff.token)).toBeNull();
      expect((await Session.findById(staff.sessionId).lean())?.revokedReason).toBe("mfa_reset");
    });

    it("works end to end through the MFA routes", async () => {
      const staff = await makeUser("coordinator");
      cookieToken = staff.token;
      const started = await enrollPost(json("/api/v1/auth/mfa/enroll", "POST"), params());
      expect(started.status).toBe(200);
      const { data } = (await started.json()) as { data: { secret: string; qrSvg: string } };
      expect(data.qrSvg).toContain("<svg");
      await confirmMfaEnrollment(staff.user._id.toString(), staff.sessionId, totpAt(data.secret, stepAt(new Date())), ctx());
      const other = await createSession(staff.user._id);
      cookieToken = other.token;
      expect(await errorCode(await verifyPost(json("/api/v1/auth/mfa/verify", "POST", { code: "12345" }), params()))).toBe("VALIDATION_ERROR");
      expect(await errorCode(await verifyPost(json("/api/v1/auth/mfa/verify", "POST", { code: "000000" }), params()))).toBe("MFA_INVALID");
    });
  });

  describe("role-based access on admin APIs", () => {
    it("requires sign-in, a staff role, the second factor, then the permission", async () => {
      expect((await auditGet(json("/api/v1/admin/audit", "GET"), params())).status).toBe(401);

      const donor = await makeUser("donor");
      cookieToken = donor.token;
      expect(await errorCode(await requestsGet(json("/api/v1/admin/requests", "GET"), params()))).toBe("FORBIDDEN");

      const superAdmin = await makeUser("super_admin");
      cookieToken = superAdmin.token;
      const unverified = await auditGet(json("/api/v1/admin/audit", "GET"), params());
      expect(unverified.status).toBe(403);
      expect(await errorCode(unverified)).toBe("MFA_REQUIRED");
      await enroll(superAdmin);
      expect((await auditGet(json("/api/v1/admin/audit", "GET"), params())).status).toBe(200);
    });

    it("lets a verified coordinator coordinate but not change system settings, WhatsApp or read the audit log", async () => {
      const coordinator = await makeUser("coordinator");
      await enroll(coordinator);
      cookieToken = coordinator.token;
      expect((await requestsGet(json("/api/v1/admin/requests", "GET"), params())).status).toBe(200);
      for (const res of [
        await auditGet(json("/api/v1/admin/audit", "GET"), params()),
        await settingsPatch(json("/api/v1/admin/operations/settings", "PATCH", { botEnabled: false, alertsPaused: true }), params()),
        await waConnectPost(json("/api/v1/admin/whatsapp/connect", "POST", {}), params()),
      ]) {
        expect(res.status).toBe(403);
        expect(await errorCode(res)).toBe("FORBIDDEN");
      }
    });

    it("treats the legacy admin role as a super admin", async () => {
      const legacy = await makeUser("admin");
      await enroll(legacy);
      cookieToken = legacy.token;
      expect((await auditGet(json("/api/v1/admin/audit", "GET"), params())).status).toBe(200);
    });

    it("applies staff session limits to coordinators", async () => {
      const coordinator = await makeUser("coordinator");
      const t = Date.now();
      expect(await findSession(coordinator.token, new Date(t + 60 * 60_000))).not.toBeNull();
      expect(await findSession(coordinator.token, new Date(t + 60 * 60_000 + 121 * 60_000))).toBeNull();
    });
  });

  describe("privilege changes", () => {
    it("ends every session at once and audits the change", async () => {
      const person = await makeUser("donor");
      const promoted = await setStaffRole(person.user._id, "coordinator", randomUUID());
      expect(promoted).toMatchObject({ previous: "donor", role: "coordinator", sessionsEnded: 1 });
      expect(await findSession(person.token)).toBeNull();
      expect(await AuditLog.exists({ action: "admin.role_granted", actorUserId: person.user._id, resourceId: "coordinator" })).toBeTruthy();

      const fresh = await createSession(person.user._id);
      const elevated = await setStaffRole(person.user._id, "super_admin", randomUUID());
      expect(elevated?.sessionsEnded).toBe(1);
      expect(await findSession(fresh.token)).toBeNull();
      expect(await AuditLog.exists({ action: "admin.role_changed", actorUserId: person.user._id, resourceId: "super_admin" })).toBeTruthy();
    });

    it("removing staff access also removes the authenticator", async () => {
      const staff = await makeUser("coordinator");
      await enroll(staff);
      await setStaffRole(staff.user._id, null, randomUUID());
      const after = (await User.findById(staff.user._id).lean())!;
      expect(after.role).toBe("donor");
      expect(after.mfa).toBeUndefined();
      expect(await findSession(staff.token)).toBeNull();
      expect(await AuditLog.exists({ action: "admin.role_revoked", actorUserId: staff.user._id })).toBeTruthy();
    });

    it("a change takes effect on the next request even for an already-verified session", async () => {
      const staff = await makeUser("super_admin");
      await enroll(staff);
      cookieToken = staff.token;
      expect((await auditGet(json("/api/v1/admin/audit", "GET"), params())).status).toBe(200);
      await setStaffRole(staff.user._id, "coordinator", randomUUID());
      expect((await auditGet(json("/api/v1/admin/audit", "GET"), params())).status).toBe(401);
    });
  });

  describe("account deletion", () => {
    async function donorWithHistory() {
      const donor = await makeUser("donor");
      const id = donor.user._id;
      await DonorProfile.create({ userId: id, bloodGroup: "B+", city: "Prayagraj", locality: "Civil Lines", availableForRequests: true, notificationConsentAt: new Date(), notificationChannels: ["whatsapp"], registeredVia: "whatsapp", registeredAt: new Date() });
      await ConsentRecord.create({ userId: id, purpose: "donor_alerts", channel: "whatsapp", action: "granted", source: "whatsapp", noticeVersion: PRIVACY_NOTICE_VERSION });
      const open = await createActiveRequest();
      const closed = await createActiveRequest({ status: "fulfilled", closedAt: new Date() });
      const now = new Date();
      await RequestResponse.create({ requestId: open._id, donorUserId: id, response: "interested", contactSharingConsentAt: now, coordinationStatus: "interested", coordinationHistory: [{ status: "interested", at: now, actor: "donor" }], respondedAt: now });
      await RequestResponse.create({ requestId: closed._id, donorUserId: id, response: "interested", contactSharingConsentAt: now, coordinationStatus: "donation_confirmed", coordinationHistory: [{ status: "donation_confirmed", at: now, actor: "admin" }], respondedAt: now });
      const message = (status: "queued" | "failed" | "delivered", failureCode?: string) => ({
        provider: "whatsapp_web" as const, kind: "emergency_request" as const, templateName: "t", requestId: open._id.toString(), recipientUserId: id,
        recipientLookup: donor.user.phoneLookup, recipientPhoneEncrypted: encryptPii(donor.phone), bodyEncrypted: encryptPii("Urgent: B+ needed"),
        status, failureCode, idempotencyKey: randomUUID(), nextAttemptAt: now, expiresAt: new Date(now.getTime() + 3_600_000),
      });
      await NotificationEvent.create([message("queued"), message("failed", "SEND_FAILED"), message("delivered")]);
      await WhatsAppConversation.create({ phoneLookup: donor.user.phoneLookup, flow: "donor_update", status: "active", state: "x", dataEncrypted: encryptPii("{}"), userId: id, startedVia: "whatsapp", expiresAt: new Date(now.getTime() + 3_600_000) });
      return { donor, open, closed };
    }

    it("erases personal data, withdraws from open requests, keeps a do-not-message entry and audit trail", async () => {
      const { donor, open, closed } = await donorWithHistory();
      const id = donor.user._id;
      const oldLookup = donor.user.phoneLookup;
      const summary = await deleteAccount(id, randomUUID());
      expect(summary).toMatchObject({ donorProfileDeleted: true, responsesWithdrawn: 1, messagesErased: 3, sessionsEnded: 1 });

      const user = (await User.findById(id).lean())!;
      expect(user.status).toBe("deleted");
      expect(user.deletedAt).toBeInstanceOf(Date);
      expect(user.displayName).toBeUndefined();
      expect(user.phoneLookup).not.toBe(oldLookup);
      expect(decryptPii(user.phoneEncrypted)).toBe("deleted");
      expect(await DonorProfile.exists({ userId: id })).toBeNull();
      expect(await WhatsAppConversation.exists({ $or: [{ userId: id }, { phoneLookup: oldLookup }] })).toBeNull();
      expect(await findSession(donor.token)).toBeNull();

      // Never messaged again, and the consent history shows the withdrawal.
      expect(await MessagingOptOut.exists({ phoneLookup: oldLookup })).toBeTruthy();
      expect(await ConsentRecord.exists({ userId: id, action: "withdrawn" })).toBeTruthy();

      const messages = await NotificationEvent.find({ recipientUserId: id }).lean();
      for (const m of messages) {
        expect(m.recipientPhoneEncrypted).toBeUndefined();
        expect(m.bodyEncrypted).toBeUndefined();
        expect(m.recipientLookup).not.toBe(oldLookup);
      }
      // Queued alerts were stopped (by the opt-out that deletion records first).
      expect(messages.some((m) => m.status === "queued" || m.status === "sending")).toBe(false);
      expect(messages.find((m) => m.status === "suppressed")?.failureCode).toBe("OPTED_OUT");
      const failed = messages.find((m) => m.status === "failed")!;
      await expect(retryFailedAlert(failed._id.toString(), new Types.ObjectId(), randomUUID())).rejects.toMatchObject({ code: "NOT_RETRYABLE" });

      const openResponse = (await RequestResponse.findOne({ requestId: open._id, donorUserId: id }).lean())!;
      expect(openResponse.coordinationStatus).toBe("not_proceeding");
      expect(openResponse.contactSharingConsentAt).toBeUndefined();
      // A coordinator-confirmed donation stays on the patient's record, without contact sharing.
      const confirmed = (await RequestResponse.findOne({ requestId: closed._id, donorUserId: id }).lean())!;
      expect(confirmed.coordinationStatus).toBe("donation_confirmed");
      expect(confirmed.contactSharingConsentAt).toBeUndefined();

      expect(await AuditLog.exists({ action: "account.deleted", actorUserId: id })).toBeTruthy();
      await expect(deleteAccount(id, randomUUID())).rejects.toMatchObject({ status: 404 });

      // The same number can sign up again later, as a new account.
      const again = await findOrCreateVerifiedUser(donor.phone, phoneLookupToken(donor.phone));
      expect(again.user._id.toString()).not.toBe(id.toString());
    });

    it("never sends a message whose recipient was erased", async () => {
      const { donor } = await donorWithHistory();
      // Simulate a message that was claimed for sending just before deletion.
      const inFlight = await NotificationEvent.create({
        provider: "whatsapp_web", kind: "emergency_request", templateName: "t", recipientUserId: donor.user._id, recipientLookup: "erased", status: "queued", priority: 0,
        idempotencyKey: randomUUID(), nextAttemptAt: new Date(0), expiresAt: new Date(Date.now() + 3_600_000), bodyEncrypted: encryptPii("x"),
      });
      const sendText = vi.fn();
      const provider = { name: "whatsapp_web", sendText } as unknown as MessagingProvider;
      await NotificationEvent.updateMany({ _id: { $ne: inFlight._id }, status: "queued" }, { $set: { status: "suppressed" } });
      expect(await dispatchNext(provider, { maxMessagesPerHour: 100, maxRepliesPerHour: 100, testRecipients: new Set(), alertsPaused: false })).toBe("suppressed");
      expect(sendText).not.toHaveBeenCalled();
      expect((await NotificationEvent.findById(inFlight._id).lean())?.failureCode).toBe("ACCOUNT_DELETED");
    });

    it("refuses staff accounts", async () => {
      const staff = await makeUser("coordinator");
      await expect(deleteAccount(staff.user._id, randomUUID())).rejects.toMatchObject({ code: "STAFF_ACCOUNT" });
      expect((await User.findById(staff.user._id).lean())?.status).toBe("active");
    });

    it("requires a fresh code and the typed confirmation through the API, then clears the cookie", async () => {
      const { donor } = await donorWithHistory();
      cookieToken = donor.token;
      let code = "";
      const capture: OtpDeliveryProvider = { channel: "development", send: async (input) => ((code = input.code), {}) };
      await requestOtp({ phoneE164: donor.phone, purpose: "account_deletion" }, ctx(), capture, null);

      expect(await errorCode(await deletionPost(json("/api/v1/account/deletion", "POST", { code, confirm: "delete" }), params()))).toBe("VALIDATION_ERROR");
      const wrong = code === "000000" ? "111111" : "000000";
      expect(await errorCode(await deletionPost(json("/api/v1/account/deletion", "POST", { code: wrong, confirm: "DELETE" }), params()))).toBe("OTP_INVALID");
      expect((await User.findById(donor.user._id).lean())?.status).toBe("active");

      // A login code can't be used to delete the account.
      await requestOtp({ phoneE164: donor.phone, purpose: "login" }, ctx(), capture, null);
      const loginCode = code;
      expect((await deletionPost(json("/api/v1/account/deletion", "POST", { code: loginCode, confirm: "DELETE" }), params())).status).not.toBe(200);

      await OtpChallenge.deleteMany({ phoneLookup: donor.user.phoneLookup });
      await RateLimitBucket.deleteMany({});
      await requestOtp({ phoneE164: donor.phone, purpose: "account_deletion" }, ctx(), capture, null);
      const res = await deletionPost(json("/api/v1/account/deletion", "POST", { code, confirm: "DELETE" }), params());
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${sessionCookieName()}=;`));
      expect((await User.findById(donor.user._id).lean())?.status).toBe("deleted");
    });
  });

  describe("retention", () => {
    it("anonymises requests closed longer than the retention period, and nothing else", async () => {
      const now = new Date();
      const old = await createActiveRequest({ status: "fulfilled", closedAt: new Date(now.getTime() - 200 * 86_400_000), hospitalPhone: "0532-2250000", patientAge: 42 });
      await EmergencyRequest.updateOne({ _id: old._id }, { $set: { "history.0.note": "Called the family on 98765 43210" } });
      const recent = await createActiveRequest({ status: "cancelled", closedAt: new Date(now.getTime() - 10 * 86_400_000) });
      const open = await createActiveRequest({ status: "active" });
      await RequestShareLink.create({ requestId: old._id, tokenHash: randomUUID(), scope: "view", createdBy: "requester", expiresAt: new Date(now.getTime() + 86_400_000) });
      await InstitutionOutreach.collection.insertOne({ requestId: old._id, institutionId: new Types.ObjectId(), rank: 1, status: "responded", deliveries: [], followUp: { status: "none" }, discoveredAt: now, response: { status: "can_assist", contactNameEncrypted: encryptPii("Dr Rao"), contactPhoneEncrypted: encryptPii("+919800000000") } });

      const count = await anonymizeClosedRequests(now, 180);
      expect(count).toBeGreaterThanOrEqual(1);
      const anon = (await EmergencyRequest.findById(old._id).lean())!;
      expect(anon.anonymizedAt).toBeInstanceOf(Date);
      expect(decryptPii(anon.patientNameEncrypted)).toBe(REMOVED);
      expect(decryptPii(anon.contactNameEncrypted)).toBe(REMOVED);
      expect(decryptPii(anon.contactPhoneEncrypted)).toBe(REMOVED);
      expect(anon.contactPhoneLookup).toBe(`anonymized:${old._id.toString()}`);
      expect(anon.patientAge).toBeUndefined();
      expect(anon.hospitalPhone).toBeUndefined();
      expect(anon.history.every((h) => h.note === undefined)).toBe(true);
      // Kept for reporting.
      expect(anon.bloodGroup).toBe("B+");
      expect(anon.hospitalName).toBe("City Hospital");
      expect(anon.status).toBe("fulfilled");
      expect(await RequestShareLink.exists({ requestId: old._id, revokedAt: null })).toBeNull();
      const outreach = await InstitutionOutreach.findOne({ requestId: old._id }).lean();
      expect(outreach?.response?.contactPhoneEncrypted).toBeUndefined();

      expect((await EmergencyRequest.findById(recent._id).lean())?.anonymizedAt).toBeUndefined();
      expect((await EmergencyRequest.findById(open._id).lean())?.anonymizedAt).toBeUndefined();
      expect(await anonymizeClosedRequests(now, 180)).toBe(0);
      expect(await AuditLog.exists({ action: "retention.requests_anonymized" })).toBeTruthy();
    });
  });

  describe("error monitoring", () => {
    it("groups errors, stores only redacted text, and alerts once per window", async () => {
      await ErrorEvent.deleteMany({});
      process.env.ERROR_ALERT_WEBHOOK_URL = "https://alerts.example.test/hook";
      const fetchMock = vi.fn(async () => new Response("ok"));
      vi.stubGlobal("fetch", fetchMock);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const context = { source: "jobs" as const, event: "jobs.dead", where: "donor_wave" };
        const t = new Date();
        await reportError(new Error("Send to +919876543210 failed with code 482913 (token aZ3kLm9Qp2Rt7Vw1Xy4Bc6Dn8Fg0Hj5Ks)"), context, t);
        await reportError(new Error("Send to +919812345678 failed with code 111222 (token bZ3kLm9Qp2Rt7Vw1Xy4Bc6Dn8Fg0Hj5Ks)"), context, new Date(t.getTime() + 1000));
        const rows = await ErrorEvent.find({ event: "jobs.dead" }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(2);
        expect(rows[0].message).toBe("Send to [phone] failed with code [code] (token [secret])");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const alert = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { text: string };
        expect(alert.text).not.toMatch(/98765|482913|aZ3k/);
        for (const call of consoleSpy.mock.calls) expect(String(call[0])).not.toMatch(/9876543210|482913|aZ3kLm9/);

        await reportError(new Error("Send to +919812345678 failed"), context, new Date(t.getTime() + 31 * 60_000));
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        consoleSpy.mockRestore();
        delete process.env.ERROR_ALERT_WEBHOOK_URL;
      }
    });

    it("records unhandled API errors by route shape, never the URL's tokens", async () => {
      await ErrorEvent.deleteMany({});
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const route = apiRoute(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'phone')");
      });
      const res = await route(json("/api/v1/requests/track/aZ3kLm9Qp2Rt7Vw1Xy4Bc6Dn8Fg0Hj5Ks", "GET"), params());
      spy.mockRestore();
      expect(res.status).toBe(500);
      const row = (await ErrorEvent.findOne({ event: "api.unhandled_error" }).lean())!;
      expect(row.where).toBe("GET /api/v1/requests/track/:id");
      expect(row.errorName).toBe("TypeError");
      expect(row.lastRequestId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("SMS sign-in codes", () => {
    const capturing = (channel: "whatsapp" | "sms" | "development", fail = false) => {
      const sent: string[] = [];
      const provider: OtpDeliveryProvider = {
        channel,
        send: async ({ code }) => {
          if (fail) throw new Error("provider down");
          sent.push(code);
          return { providerMessageId: `${channel}-${sent.length}` };
        },
      };
      return { provider, sent };
    };
    const smsOption = (perPhoneDaily = 3, dailyCap = 500) => {
      const c = capturing("sms");
      return { ...c, option: { provider: c.provider, perPhoneDaily, dailyCap } satisfies SmsOtpOption };
    };

    it("falls back to SMS when WhatsApp fails, with the same single code", async () => {
      const phone = randomMobile("9");
      const whatsapp = capturing("whatsapp", true);
      const sms = smsOption();
      const result = await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), whatsapp.provider, sms.option);
      expect(result).toMatchObject({ channel: "sms", fellBackToSms: true, smsAvailable: true });
      expect(sms.sent).toHaveLength(1);
      const challenges = await OtpChallenge.find({ phoneLookup: phoneLookupToken(phone) }).lean();
      expect(challenges).toHaveLength(1);
      expect(challenges[0]).toMatchObject({ deliveryChannel: "sms", providerMessageId: "sms-1" });
    });

    it("sends by SMS when asked, and refuses when SMS isn't configured", async () => {
      const phone = randomMobile("9");
      const sms = smsOption();
      const whatsapp = capturing("whatsapp");
      expect(await requestOtp({ phoneE164: phone, purpose: "login", channel: "sms" }, ctx(), whatsapp.provider, sms.option)).toMatchObject({ channel: "sms", fellBackToSms: false });
      expect(whatsapp.sent).toHaveLength(0);
      await expect(requestOtp({ phoneE164: randomMobile("9"), purpose: "login", channel: "sms" }, ctx(), whatsapp.provider, null)).rejects.toMatchObject({ code: "SMS_UNAVAILABLE" });
      expect(await requestOtp({ phoneE164: randomMobile("9"), purpose: "login" }, ctx(), whatsapp.provider, null)).toMatchObject({ channel: "whatsapp", smsAvailable: false });
    });

    it("caps SMS per number per day and service-wide, and leaves no usable challenge behind", async () => {
      const phone = randomMobile("9");
      const sms = smsOption(2, 500);
      const t = Date.now();
      for (let i = 0; i < 2; i++) {
        await requestOtp({ phoneE164: phone, purpose: "login", channel: "sms" }, ctx(`192.0.2.${i}`), capturing("whatsapp").provider, sms.option);
        // Past the 30-second resend wait (createdAt is immutable through Mongoose).
        await OtpChallenge.collection.updateMany({}, { $set: { createdAt: new Date(t - 60_000) } });
      }
      await expect(requestOtp({ phoneE164: phone, purpose: "login", channel: "sms" }, ctx("192.0.2.9"), capturing("whatsapp").provider, sms.option)).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(sms.sent).toHaveLength(2);

      // The service-wide cap counts every SMS today; start from an empty count.
      await RateLimitBucket.deleteMany({});
      const capped = smsOption(3, 1);
      await requestOtp({ phoneE164: randomMobile("9"), purpose: "login", channel: "sms" }, ctx("192.0.2.20"), capturing("whatsapp").provider, capped.option);
      const blocked = randomMobile("9");
      await expect(requestOtp({ phoneE164: blocked, purpose: "login" }, ctx("192.0.2.21"), capturing("whatsapp", true).provider, capped.option)).rejects.toMatchObject({ code: "OTP_DELIVERY_FAILED" });
      expect(await OtpChallenge.exists({ phoneLookup: phoneLookupToken(blocked) })).toBeNull();
    });

    it("limits SMS per IP", async () => {
      const sms = smsOption(5, 500);
      const codes = [];
      for (let i = 0; i < 6; i++) {
        codes.push(await requestOtp({ phoneE164: randomMobile("9"), purpose: "login", channel: "sms" }, ctx("192.0.2.77"), capturing("whatsapp").provider, sms.option).then(() => "ok", (e: { code: string }) => e.code));
      }
      expect(codes.slice(0, 5)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
      expect(codes[5]).toBe("RATE_LIMITED");
    });
  });
});
