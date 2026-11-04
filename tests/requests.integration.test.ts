import { randomInt, randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequestSchema } from "@/features/requests/schemas";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import type { ApiContext } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { handleInboundMessage } from "@/server/messaging/inbound";
import { recordOptOut } from "@/server/messaging/opt-out";
import { AuditLog } from "@/server/models/audit-log";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { IdempotencyRecord } from "@/server/models/idempotency-record";
import { NotificationEvent } from "@/server/models/notification-event";
import { RequestShareLink } from "@/server/models/request-share-link";
import { WhatsAppConnection } from "@/server/models/whatsapp-connection";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import {
  adminUpdateStatus,
  createFamilyLink,
  createRequest,
  getAdminRequestDetail,
  getTrackedRequest,
  listRequests,
  requesterUpdateStatus,
  revokeFamilyLink,
} from "@/server/requests/service";
import { allowedTransitions, canTransition, computeExpiry } from "@/server/requests/status";

/**
 * Emergency request lifecycle against MongoDB.
 * Enable with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test npm test
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);

const ctx = (): ApiContext => ({ requestId: randomUUID(), ip: `10.9.${randomInt(255)}.${randomInt(255)}`, userAgent: "vitest" });
const randomPhone = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
const admin = new Types.ObjectId();

function body(overrides: Record<string, unknown> = {}) {
  return createRequestSchema.parse({
    patientName: "Sunita Devi",
    patientAge: 54,
    contactName: "Rohit Kumar",
    contactPhone: randomPhone(),
    bloodGroup: "B+",
    component: "packed_red_cells",
    unitsRequested: 2,
    requiredBy: inHours(6),
    priority: "critical",
    hospitalName: "City General Hospital",
    hospitalAddress: "12 MG Road, Civil Lines",
    city: "Prayagraj",
    locality: "Civil Lines",
    hospitalPhone: "0532 240 1234",
    location: { latitude: 25.45678, longitude: 81.84321 },
    whatsappUpdates: false,
    consent: true,
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    ...overrides,
  });
}

const tokenOf = (url: string) => url.split("/track/")[1];

async function expectAppError(promise: Promise<unknown>, code: string, status?: number) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (status) expect((error as AppError).status).toBe(status);
  return error as AppError;
}

describe("request lifecycle rules", () => {
  it("never lets a requester verify, and closes final states", () => {
    expect(canTransition("requester", "pending_verification", "verified")).toBe(false);
    expect(canTransition("admin", "pending_verification", "verified")).toBe(true);
    expect(canTransition("admin", "pending_verification", "fulfilled")).toBe(false);
    for (const final of ["fulfilled", "cancelled", "expired"] as const) {
      expect(allowedTransitions("admin", final)).toEqual([]);
      expect(allowedTransitions("requester", final)).toEqual([]);
    }
  });

  it("expires a day after the required-by time, capped at 14 days", () => {
    const created = new Date("2026-11-04T00:00:00Z");
    expect(computeExpiry(created, new Date("2026-11-05T00:00:00Z")).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(computeExpiry(created, new Date("2026-11-30T00:00:00Z")).toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });

  it("validates required fields and sensible values", () => {
    const valid = {
      patientName: "S D", patientAge: null, contactName: "Rohit", contactPhone: "9876543210", bloodGroup: "unknown", component: "platelets",
      unitsRequested: 1, requiredBy: inHours(2), priority: "urgent", hospitalName: "AIIMS", hospitalAddress: "Ansari Nagar East",
      city: "Delhi", locality: "Ansari Nagar", hospitalPhone: null, location: null, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    };
    expect(createRequestSchema.safeParse(valid).success).toBe(true);
    for (const [field, value] of [
      ["contactPhone", "12345"], ["unitsRequested", 0], ["unitsRequested", 25], ["requiredBy", inHours(-3)], ["requiredBy", inHours(24 * 40)],
      ["consent", false], ["bloodGroup", "C+"], ["component", "blood"], ["hospitalName", ""], ["patientAge", 150],
      ["location", { latitude: 51.5, longitude: -0.1 }],
    ] as const) {
      expect(createRequestSchema.safeParse({ ...valid, [field]: value }).success, `${field}=${JSON.stringify(value)}`).toBe(false);
    }
    expect(createRequestSchema.safeParse({ ...valid, diagnosis: "x" }).success).toBe(false); // no extra medical fields
  });
});

describe.skipIf(!enabled)("Emergency requests (MongoDB)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all([EmergencyRequest, RequestShareLink, IdempotencyRecord, NotificationEvent].map((m) => m.syncIndexes()));
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await WhatsAppConnection.deleteMany({});
  });

  it("creates a request without an account, encrypting patient and contact details", async () => {
    const input = body();
    const res = await createRequest(input, randomUUID(), ctx());
    expect(res.publicRequestId).toMatch(/^MX-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(res).toMatchObject({ status: "pending_verification", whatsappConfirmation: "not_requested", replayed: false });
    expect(res.manageUrl).toMatch(/^http:\/\/localhost:3000\/track\/[A-Za-z0-9_-]{43}$/);

    const raw = JSON.stringify(await EmergencyRequest.collection.findOne({ publicRequestId: res.publicRequestId }));
    for (const secret of ["Sunita", "Rohit", input.contactPhone.slice(3)]) expect(raw).not.toContain(secret);
    expect(raw).toContain('"coordinates":[81.843,25.457]'); // ~100 m precision
    expect(raw).not.toContain(tokenOf(res.manageUrl)); // only token hashes are stored
  });

  it("returns the same result for a retried submission and blocks a duplicate", async () => {
    const input = body();
    const key = randomUUID();
    const first = await createRequest(input, key, ctx());
    const retry = await createRequest(input, key, ctx());
    expect(retry).toEqual({ ...first, replayed: true });

    await expectAppError(createRequest(input, randomUUID(), ctx()), "DUPLICATE_REQUEST", 409);
    expect(await EmergencyRequest.countDocuments({ contactPhoneLookup: phoneLookupToken(input.contactPhone) })).toBe(1);

    // A genuinely different need from the same family is allowed.
    const platelets = await createRequest({ ...input, component: "platelets" }, randomUUID(), ctx());
    expect(platelets.publicRequestId).not.toBe(first.publicRequestId);
  });

  it("rate-limits submissions per phone number", async () => {
    const phone = randomPhone();
    for (let i = 0; i < 3; i++) await createRequest(body({ contactPhone: phone, hospitalName: `Hospital ${i}` }), randomUUID(), ctx());
    await expectAppError(createRequest(body({ contactPhone: phone, hospitalName: "Hospital X" }), randomUUID(), ctx()), "RATE_LIMITED", 429);
  });

  it("tracking shows status and hospital but no patient, contact or location details", async () => {
    const res = await createRequest(body(), randomUUID(), ctx());
    const view = await getTrackedRequest(tokenOf(res.manageUrl), res.publicRequestId);
    expect(view).toMatchObject({ publicRequestId: res.publicRequestId, status: "pending_verification", bloodGroup: "B+", unitsRequested: 2, verifiedAt: null });
    expect(view.hospital.name).toBe("City General Hospital");
    expect(view.manage?.allowedStatuses).toEqual(["fulfilled", "cancelled"]);
    const json = JSON.stringify(view);
    for (const secret of ["Sunita", "Rohit", "25.45", "81.84"]) expect(json).not.toContain(secret);

    const family = await createFamilyLink(tokenOf(res.manageUrl), res.publicRequestId, 24, ctx());
    const familyView = await getTrackedRequest(tokenOf(family.url));
    expect(familyView.manage).toBeNull();
    expect(familyView.link.scope).toBe("view");

    // A view link can't change anything, and tokens are bound to their request.
    await expectAppError(requesterUpdateStatus(tokenOf(family.url), res.publicRequestId, "cancelled", ctx()), "NOT_FOUND", 404);
    await expectAppError(getTrackedRequest(tokenOf(res.manageUrl), "MX-00000000"), "NOT_FOUND", 404);
    await expectAppError(getTrackedRequest("A".repeat(43)), "NOT_FOUND", 404);
  });

  it("refuses expired and revoked links", async () => {
    const res = await createRequest(body(), randomUUID(), ctx());
    const manage = tokenOf(res.manageUrl);
    const family = await createFamilyLink(manage, res.publicRequestId, 72, ctx());
    await revokeFamilyLink(manage, res.publicRequestId, family.id, ctx());
    await expectAppError(getTrackedRequest(tokenOf(family.url)), "TRACKING_LINK_REVOKED", 410);

    await RequestShareLink.updateMany({ scope: "manage" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expectAppError(getTrackedRequest(manage), "TRACKING_LINK_EXPIRED", 410);
  });

  it("lets the requester cancel, after which nothing else can change it", async () => {
    const res = await createRequest(body(), randomUUID(), ctx());
    const token = tokenOf(res.manageUrl);
    await expectAppError(requesterUpdateStatus(token, res.publicRequestId, "partially_fulfilled", ctx()), "INVALID_TRANSITION", 409);
    const cancelled = await requesterUpdateStatus(token, res.publicRequestId, "cancelled", ctx());
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.history.map((h) => [h.status, h.actor])).toEqual([["pending_verification", "requester"], ["cancelled", "requester"]]);
    await expectAppError(adminUpdateStatus(res.publicRequestId, "verified", undefined, admin, ctx()), "INVALID_TRANSITION", 409);
  });

  it("admins verify and move a request through its lifecycle, with history and audit", async () => {
    const res = await createRequest(body(), randomUUID(), ctx());
    await expectAppError(adminUpdateStatus(res.publicRequestId, "fulfilled", undefined, admin, ctx()), "INVALID_TRANSITION");
    await adminUpdateStatus(res.publicRequestId, "verified", "Confirmed with blood bank", admin, ctx());
    await adminUpdateStatus(res.publicRequestId, "active", undefined, admin, ctx());
    await adminUpdateStatus(res.publicRequestId, "partially_fulfilled", "1 of 2 units arranged", admin, ctx());
    await requesterUpdateStatus(tokenOf(res.manageUrl), res.publicRequestId, "fulfilled", ctx());

    const detail = await getAdminRequestDetail(res.publicRequestId, admin, { requestId: "t" });
    expect(detail).toMatchObject({ status: "fulfilled", patientName: "Sunita Devi", contactName: "Rohit Kumar", patientAge: 54, allowedStatuses: [] });
    expect(detail.verifiedAt).not.toBeNull();
    expect(detail.closedAt).not.toBeNull();
    expect(detail.history.map((h) => `${h.status}:${h.actor}`)).toEqual([
      "pending_verification:requester", "verified:admin", "active:admin", "partially_fulfilled:admin", "fulfilled:requester",
    ]);
    expect(detail.history[1].note).toBe("Confirmed with blood bank");

    // Admin notes stay internal: tracking shows who and when, not the note.
    const tracked = await getTrackedRequest(tokenOf(res.manageUrl));
    expect(JSON.stringify(tracked)).not.toContain("Confirmed with blood bank");
    expect(await AuditLog.countDocuments({ action: "request.status_changed", resourceId: { $regex: `^${res.publicRequestId}:` } })).toBe(4);
    expect(await AuditLog.countDocuments({ action: "request.viewed_by_admin", resourceId: res.publicRequestId })).toBe(1);
  });

  it("expires overdue requests automatically and records it", async () => {
    const res = await createRequest(body(), randomUUID(), ctx());
    await EmergencyRequest.updateOne({ publicRequestId: res.publicRequestId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const view = await getTrackedRequest(tokenOf(res.manageUrl));
    expect(view.status).toBe("expired");
    expect(view.history.at(-1)).toMatchObject({ status: "expired", actor: "system" });
    expect(view.manage?.allowedStatuses).toEqual([]);
  });

  describe("WhatsApp confirmation", () => {
    const connect = () =>
      WhatsAppConnection.create({ _id: "primary", state: "connected", busy: false, heartbeatAt: new Date(), leaseOwner: "test", leaseExpiresAt: new Date(Date.now() + 30000) });

    it("isn't promised when WhatsApp isn't connected", async () => {
      const res = await createRequest(body({ whatsappUpdates: true }), randomUUID(), ctx());
      expect(res.whatsappConfirmation).toBe("unavailable");
      expect(await NotificationEvent.countDocuments({ kind: "request_confirmation" })).toBe(0);
    });

    it("queues one confirmation with a read-only link and no patient details", async () => {
      await connect();
      const input = body({ whatsappUpdates: true });
      const res = await createRequest(input, randomUUID(), ctx());
      expect(res.whatsappConfirmation).toBe("queued");
      const event = await NotificationEvent.findOne({ kind: "request_confirmation", recipientLookup: phoneLookupToken(input.contactPhone) }).lean();
      const text = decryptPii(event!.bodyEncrypted!);
      expect(text).toContain(res.publicRequestId);
      expect(text).not.toContain("Sunita");
      const viewToken = text.match(/\/track\/([A-Za-z0-9_-]{43})/)![1];
      expect(viewToken).not.toBe(tokenOf(res.manageUrl));
      expect((await getTrackedRequest(viewToken)).manage).toBeNull();
    });

    it("respects an earlier STOP", async () => {
      await connect();
      const input = body({ whatsappUpdates: true });
      await recordOptOut(`+91${input.contactPhone.slice(-10)}`, "whatsapp_stop");
      expect((await createRequest(input, randomUUID(), ctx())).whatsappConfirmation).toBe("suppressed");
    });
  });

  it("gives a requester replying on WhatsApp a request-aware answer, not the donor sign-up", async () => {
    const input = body();
    await createRequest(input, randomUUID(), ctx());
    await handleInboundMessage({ providerMessageId: `in-${randomUUID()}`, fromE164: input.contactPhone, input: { type: "text", text: "thank you" } });
    const reply = await NotificationEvent.findOne({ recipientLookup: phoneLookupToken(input.contactPhone), kind: "bot_reply" }).lean();
    expect(decryptPii(reply!.bodyEncrypted!)).toMatch(/received your blood request/);
    expect(await WhatsAppConversation.countDocuments({ phoneLookup: phoneLookupToken(input.contactPhone) })).toBe(0);
  });

  it("reports real counts and filters by status, blood group, city and ID", async () => {
    await EmergencyRequest.deleteMany({});
    const a = await createRequest(body({ bloodGroup: "O-", city: "Lucknow" }), randomUUID(), ctx());
    await createRequest(body({ bloodGroup: "O-", city: "Kanpur" }), randomUUID(), ctx());
    const c = await createRequest(body({ bloodGroup: "AB+", city: "lucknow" }), randomUUID(), ctx());
    await adminUpdateStatus(c.publicRequestId, "verified", undefined, admin, ctx());

    const all = await listRequests({});
    expect(all.stats.total).toBe(3);
    expect(all.stats.byStatus).toMatchObject({ pending_verification: 2, verified: 1, fulfilled: 0 });
    expect((await listRequests({ bloodGroup: "O-" })).requests).toHaveLength(2);
    expect((await listRequests({ city: "LUCKNOW" })).requests).toHaveLength(2);
    expect((await listRequests({ status: "verified" })).requests.map((r) => r.publicRequestId)).toEqual([c.publicRequestId]);
    expect((await listRequests({ q: a.publicRequestId })).requests).toHaveLength(1);
  });
});
