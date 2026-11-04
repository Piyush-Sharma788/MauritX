import "server-only";
import { Types } from "mongoose";
import {
  isOpenStatus,
  OPEN_STATUSES,
  REQUEST_STATUSES,
  type CreateRequestInput,
  type RequestStatus,
} from "@/features/requests/schemas";
import type {
  AdminRequestDetail,
  AdminRequestList,
  AdminRequestStats,
  AdminRequestSummary,
  CreateRequestResponse,
  TrackedRequestView,
} from "@/features/requests/types";
import type { ApiContext } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { getEnv } from "@/lib/env";
import {
  decryptPii,
  dedupeHash,
  encryptPii,
  generatePublicRequestId,
  generateTrackingToken,
  hashTrackingToken,
  phoneLookupToken,
} from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { withdrawQueuedAlerts } from "@/server/coordination/alerts";
import { onRequestActivated, onRequestClosed } from "@/server/coordination/automation";
import { recordEvent } from "@/server/coordination/events";
import { disclosedDonors } from "@/server/coordination/requester";
import { requesterCoordination } from "@/server/coordination/requester-view";
import { queueRequestConfirmation } from "@/server/requests/notifications";
import { allowedTransitions, canTransition, computeExpiry } from "@/server/requests/status";
import { EmergencyRequest, type EmergencyRequestDoc } from "@/server/models/emergency-request";
import { IdempotencyRecord } from "@/server/models/idempotency-record";
import { ContactAccessLog } from "@/server/models/contact-access-log";
import { RequestShareLink, type RequestShareLinkDoc } from "@/server/models/request-share-link";
import { recordAudit } from "@/server/services/audit";
import { enforceRateLimit } from "@/server/services/rate-limit";

export type RequestRecord = EmergencyRequestDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type LinkRecord = RequestShareLinkDoc & { _id: Types.ObjectId; createdAt: Date };

const DAY_MS = 24 * 60 * 60 * 1000;
const MANAGE_LINK_GRACE_MS = 7 * DAY_MS;
const DUPLICATE_WINDOW_MS = DAY_MS;

const RATE_LIMITS = {
  createPerIp: { scope: "request-create:ip", limit: 10, windowSeconds: 60 * 60 },
  createPerPhone: { scope: "request-create:phone", limit: 3, windowSeconds: 24 * 60 * 60 },
  createPerWhatsAppSender: { scope: "request-create:wa-sender", limit: 3, windowSeconds: 24 * 60 * 60 },
};

export interface CreateRequestOptions {
  /** "whatsapp": created by the bot for the sender of the conversation. */
  channel?: "web" | "whatsapp";
  /** The WhatsApp sender (E.164), authenticated by WhatsApp itself. */
  requesterE164?: string;
}

const notFound = () => new AppError(404, "NOT_FOUND", "We couldn't find that request.");
const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;
const normalise = (v: string) => v.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function trackingUrl(token: string) {
  return new URL(`/track/${token}`, getEnv().APP_BASE_URL).toString();
}

async function createLink(requestId: Types.ObjectId, scope: "manage" | "view", createdBy: "requester" | "admin" | "system", expiresAt: Date) {
  const token = generateTrackingToken();
  const link = await RequestShareLink.create({ requestId, tokenHash: hashTrackingToken(token), scope, createdBy, expiresAt });
  return { token, link };
}

/** Open requests past their expiry become `expired`. Called on every read path. */
export async function expireOverdueRequests(now = new Date()): Promise<number> {
  const result = await EmergencyRequest.updateMany(
    { status: { $in: OPEN_STATUSES }, expiresAt: { $lte: now } },
    { $set: { status: "expired", closedAt: now }, $push: { history: { status: "expired", at: now, actor: "system" } } },
  );
  return result.modifiedCount;
}

/* ------------------------------------------------------------------------ */
/* Create                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Creates a request without an account. Protected by:
 * - an idempotency key (a retried submission returns the original result);
 * - duplicate detection (same phone, blood group, component and hospital
 *   while an earlier request is still open);
 * - per-IP and per-phone rate limits.
 * The request starts as pending verification; only an admin can verify it.
 */
export async function createRequest(
  input: CreateRequestInput,
  idempotencyKey: string,
  ctx: ApiContext,
  now = new Date(),
  options: CreateRequestOptions = {},
): Promise<CreateRequestResponse> {
  await connectToDatabase();
  const scopedKey = `request:create:${idempotencyKey}`;
  const replay = await IdempotencyRecord.findOne({ key: scopedKey }).lean();
  if (replay) return { ...(JSON.parse(decryptPii(replay.responseEncrypted)) as CreateRequestResponse), replayed: true };

  const contactLookup = phoneLookupToken(input.contactPhone);
  const dedupeKey = dedupeHash([input.contactPhone, input.bloodGroup, input.component, normalise(input.hospitalName), normalise(input.city)].join("|"));
  const duplicate = await EmergencyRequest.exists({
    dedupeKey,
    status: { $in: OPEN_STATUSES },
    createdAt: { $gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) },
  });
  if (duplicate) {
    throw new AppError(
      409,
      "DUPLICATE_REQUEST",
      "A matching request from this number for the same hospital and blood is already open. Use the tracking link you saved, or contact MarutiX if you've lost it.",
    );
  }
  // After the duplicate check, so a family resubmitting is told to use their existing request.
  const viaWhatsApp = options.channel === "whatsapp" && options.requesterE164;
  const requesterLookup = viaWhatsApp ? phoneLookupToken(options.requesterE164!) : null;
  if (requesterLookup) {
    // WhatsApp messages have no client IP; the sender's own number is the limit key.
    await enforceRateLimit(RATE_LIMITS.createPerWhatsAppSender, requesterLookup, now);
  } else {
    await enforceRateLimit(RATE_LIMITS.createPerIp, ctx.ip, now);
  }
  await enforceRateLimit(RATE_LIMITS.createPerPhone, contactLookup, now);

  const expiresAt = computeExpiry(now, input.requiredBy);
  const base = {
    status: "pending_verification" as const,
    priority: input.priority,
    patientNameEncrypted: encryptPii(input.patientName),
    ...(input.patientAge !== null ? { patientAge: input.patientAge } : {}),
    contactNameEncrypted: encryptPii(input.contactName),
    contactPhoneEncrypted: encryptPii(input.contactPhone),
    contactPhoneLookup: contactLookup,
    bloodGroup: input.bloodGroup,
    component: input.component,
    unitsRequested: input.unitsRequested,
    requiredBy: input.requiredBy,
    hospitalName: input.hospitalName,
    hospitalAddress: input.hospitalAddress,
    city: input.city,
    cityNormalized: normalise(input.city),
    locality: input.locality,
    ...(input.hospitalPhone ? { hospitalPhone: input.hospitalPhone } : {}),
    ...(input.location
      ? {
          // About 100 m: enough for future nearby matching, never exact.
          location: { type: "Point" as const, coordinates: [Math.round(input.location.longitude * 1000) / 1000, Math.round(input.location.latitude * 1000) / 1000] },
        }
      : {}),
    whatsappUpdates: input.whatsappUpdates,
    createdVia: requesterLookup ? ("whatsapp" as const) : ("web" as const),
    ...(requesterLookup ? { requesterPhoneLookup: requesterLookup, requesterPhoneEncrypted: encryptPii(options.requesterE164!) } : {}),
    consent: { sharingAcceptedAt: now, privacyNoticeVersion: input.privacyNoticeVersion },
    dedupeKey,
    history: [{ status: "pending_verification" as const, at: now, actor: "requester" as const, ...(requesterLookup ? { note: "Created on WhatsApp" } : {}) }],
    expiresAt,
  };

  let request: RequestRecord | null = null;
  for (let attempt = 0; attempt < 5 && !request; attempt++) {
    try {
      request = (await EmergencyRequest.create({ ...base, publicRequestId: generatePublicRequestId() })).toObject() as RequestRecord;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  if (!request) throw new Error("Could not allocate a request ID");

  const manageExpiresAt = new Date(expiresAt.getTime() + MANAGE_LINK_GRACE_MS);
  const { token: manageToken } = await createLink(request._id, "manage", "requester", manageExpiresAt);

  let whatsappConfirmation: CreateRequestResponse["whatsappConfirmation"] = "not_requested";
  if (input.whatsappUpdates) {
    // WhatsApp gets a read-only link: if the number was mistyped, a stranger can't change the request.
    const viewExpiresAt = new Date(Math.min(manageExpiresAt.getTime(), now.getTime() + 7 * DAY_MS));
    const { token: viewToken } = await createLink(request._id, "view", "system", viewExpiresAt);
    whatsappConfirmation = await queueRequestConfirmation({
      requestId: request._id,
      publicRequestId: request.publicRequestId,
      phoneE164: input.contactPhone,
      trackUrl: trackingUrl(viewToken),
    });
  }

  await recordAudit({
    action: requesterLookup ? "request.created_via_whatsapp" : "request.created",
    outcome: "success",
    requestId: ctx.requestId,
    resourceType: "emergency_request",
    resourceId: request.publicRequestId,
  });

  const response: CreateRequestResponse = {
    publicRequestId: request.publicRequestId,
    status: "pending_verification",
    manageUrl: trackingUrl(manageToken),
    manageLinkExpiresAt: manageExpiresAt.toISOString(),
    whatsappConfirmation,
    replayed: false,
  };
  await IdempotencyRecord.create({
    key: scopedKey,
    responseEncrypted: encryptPii(JSON.stringify(response)),
    expiresAt: new Date(now.getTime() + DAY_MS),
  }).catch((error: unknown) => {
    if (!isDuplicateKeyError(error)) throw error;
  });
  return response;
}

/* ------------------------------------------------------------------------ */
/* Tracking links                                                           */
/* ------------------------------------------------------------------------ */

/** Resolves a tracking token to its link and request, enforcing expiry and revocation. */
export async function resolveTrackingToken(token: string, now = new Date()): Promise<{ link: LinkRecord; request: RequestRecord }> {
  await connectToDatabase();
  const link = (await RequestShareLink.findOne({ tokenHash: hashTrackingToken(token) }).lean()) as LinkRecord | null;
  if (!link) throw notFound();
  if (link.revokedAt) throw new AppError(410, "TRACKING_LINK_REVOKED", "This tracking link has been turned off.");
  if (link.expiresAt <= now) throw new AppError(410, "TRACKING_LINK_EXPIRED", "This tracking link has expired.");
  await expireOverdueRequests(now);
  const request = (await EmergencyRequest.findById(link.requestId).lean()) as RequestRecord | null;
  if (!request) throw notFound();
  return { link, request };
}

async function toTrackedView(request: RequestRecord, link: LinkRecord): Promise<TrackedRequestView> {
  const manage = link.scope === "manage";
  const contactsLink = link.scope === "donor_contacts";
  const shareLinks = manage
    ? ((await RequestShareLink.find({ requestId: request._id, scope: { $in: ["view", "donor_contacts"] }, createdBy: "requester" }).sort({ createdAt: -1 }).limit(20).lean()) as LinkRecord[])
    : [];
  const coordination = contactsLink ? null : await requesterCoordination(request, manage ? "manage" : "view");
  // A donor-contacts link shows consenting donors' contacts; each view is logged.
  const donorContacts = contactsLink ? await disclosedDonors(request, { via: "donor_contacts_link", linkId: link._id }) : null;
  return {
    publicRequestId: request.publicRequestId,
    status: request.status,
    priority: request.priority,
    bloodGroup: request.bloodGroup,
    component: request.component,
    unitsRequested: request.unitsRequested,
    requiredBy: request.requiredBy.toISOString(),
    hospital: {
      name: request.hospitalName,
      address: request.hospitalAddress,
      city: request.city,
      locality: request.locality,
      phone: request.hospitalPhone ?? null,
    },
    verifiedAt: iso(request.verifiedAt),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
    history: request.history.map((h) => ({ status: h.status, at: h.at.toISOString(), actor: h.actor })),
    link: { scope: link.scope, expiresAt: link.expiresAt.toISOString() },
    manage: manage
      ? {
          contactMaskedPhone: maskPhone(decryptPii(request.contactPhoneEncrypted)),
          allowedStatuses: allowedTransitions("requester", request.status),
          deviceLocationShared: Boolean(request.location?.coordinates?.length),
          whatsappUpdates: request.whatsappUpdates,
          shareLinks: shareLinks.map((l) => ({
            id: l._id.toString(),
            createdAt: l.createdAt.toISOString(),
            expiresAt: l.expiresAt.toISOString(),
            revoked: Boolean(l.revokedAt),
            scope: l.scope === "donor_contacts" ? ("donor_contacts" as const) : ("view" as const),
          })),
        }
      : null,
    coordination,
    donorContacts,
  };
}

/** Public tracking view for a token, scoped to the request in the URL. */
export async function getTrackedRequest(token: string, publicRequestId?: string): Promise<TrackedRequestView> {
  const { link, request } = await resolveTrackingToken(token);
  if (publicRequestId && request.publicRequestId !== publicRequestId) throw notFound();
  return toTrackedView(request, link);
}

export async function requireManageLink(token: string, publicRequestId: string) {
  const { link, request } = await resolveTrackingToken(token);
  // A view link, or a link for another request, gets the same answer as a missing one.
  if (link.scope !== "manage" || request.publicRequestId !== publicRequestId) throw notFound();
  return { link, request };
}

export type TransitionActor = { type: "requester" | "admin" | "institution"; userId?: Types.ObjectId; contactId?: Types.ObjectId; note?: string };

export async function applyTransition(request: RequestRecord, to: RequestStatus, actor: TransitionActor, ctx: Pick<ApiContext, "requestId">, now = new Date()) {
  if (!canTransition(actor.type, request.status, to)) {
    throw new AppError(409, "INVALID_TRANSITION", `A request that is ${request.status.replace(/_/g, " ")} can't be changed to ${to.replace(/_/g, " ")}.`);
  }
  const $set: Record<string, unknown> = { status: to };
  if (to === "verified") Object.assign($set, { verifiedAt: now, verifiedBy: actor.userId });
  if (!isOpenStatus(to)) $set.closedAt = now;
  const entry = {
    status: to,
    at: now,
    actor: actor.type,
    ...(actor.userId ? { actorUserId: actor.userId } : {}),
    ...(actor.contactId ? { actorContactId: actor.contactId } : {}),
    ...(actor.note ? { note: actor.note } : {}),
  };

  // Conditional on the current status, so two concurrent updates can't both apply.
  const result = await EmergencyRequest.updateOne({ _id: request._id, status: request.status }, { $set, $push: { history: entry } });
  if (result.modifiedCount !== 1) {
    throw new AppError(409, "CONFLICT", "This request was just updated by someone else. Refresh and try again.");
  }
  await recordAudit({
    action: "request.status_changed",
    outcome: "success",
    requestId: ctx.requestId,
    actorUserId: actor.userId,
    resourceType: "emergency_request",
    resourceId: `${request.publicRequestId}:${request.status}->${to}`,
  });
  // A closed request must not reach anyone else.
  if (!isOpenStatus(to)) {
    await withdrawQueuedAlerts(request._id, now);
    await onRequestClosed(request._id, now);
    await recordEvent(request._id, "request_closed", `Request marked ${to.replace(/_/g, " ")}.`, { visibleToRequester: true, actor: actor.type === "requester" ? "requester" : actor.type === "institution" ? "institution" : "admin", at: now });
  } else if (to === "active") {
    // Automated discovery, outreach and donor waves begin only after an admin activates the request.
    await onRequestActivated(request._id);
  }
}

/** The requester (manage link) cancels or reports their own outcome. */
export async function requesterUpdateStatus(token: string, publicRequestId: string, status: "partially_fulfilled" | "fulfilled" | "cancelled", ctx: ApiContext) {
  const { request, link } = await requireManageLink(token, publicRequestId);
  await applyTransition(request, status, { type: "requester" }, ctx);
  return toTrackedView((await EmergencyRequest.findById(request._id).lean()) as RequestRecord, link);
}

/** A time-limited, read-only link the requester can share with family. */
export async function createFamilyLink(token: string, publicRequestId: string, hours: 24 | 72 | 168, ctx: ApiContext) {
  const { request, link } = await requireManageLink(token, publicRequestId);
  const expiresAt = new Date(Math.min(Date.now() + hours * 60 * 60 * 1000, link.expiresAt.getTime()));
  const { token: viewToken, link: created } = await createLink(request._id, "view", "requester", expiresAt);
  await recordAudit({ action: "request.link_created", outcome: "success", requestId: ctx.requestId, resourceType: "emergency_request", resourceId: request.publicRequestId });
  return { id: created._id.toString(), url: trackingUrl(viewToken), expiresAt: expiresAt.toISOString() };
}

export async function revokeFamilyLink(token: string, publicRequestId: string, linkId: string, ctx: ApiContext) {
  const { request } = await requireManageLink(token, publicRequestId);
  if (!Types.ObjectId.isValid(linkId)) throw notFound();
  const link = await RequestShareLink.findOneAndUpdate(
    { _id: linkId, requestId: request._id, scope: { $in: ["view", "donor_contacts"] }, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { returnDocument: "after", lean: true },
  );
  if (!link) throw notFound();
  if (link.scope === "donor_contacts") {
    await ContactAccessLog.create({ requestId: request._id, action: "share_link_revoked", via: "manage_link", linkId: link._id, at: new Date() });
  }
  await recordAudit({ action: "request.link_revoked", outcome: "success", requestId: ctx.requestId, resourceType: "emergency_request", resourceId: request.publicRequestId });
}

/* ------------------------------------------------------------------------ */
/* Admin                                                                    */
/* ------------------------------------------------------------------------ */

function toSummary(r: RequestRecord): AdminRequestSummary {
  return {
    publicRequestId: r.publicRequestId,
    status: r.status,
    priority: r.priority,
    bloodGroup: r.bloodGroup,
    component: r.component,
    unitsRequested: r.unitsRequested,
    hospitalName: r.hospitalName,
    city: r.city,
    locality: r.locality,
    requiredBy: r.requiredBy.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

export async function getRequestStats(): Promise<AdminRequestStats> {
  await connectToDatabase();
  await expireOverdueRequests();
  const rows = await EmergencyRequest.aggregate<{ _id: RequestStatus; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
  const byStatus = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<RequestStatus, number>;
  for (const row of rows) byStatus[row._id] = row.count;
  return { total: rows.reduce((sum, r) => sum + r.count, 0), byStatus };
}

export interface RequestFilters {
  q?: string;
  status?: RequestStatus;
  bloodGroup?: string;
  city?: string;
  cursor?: string;
  limit?: number;
}

export async function listRequests(filters: RequestFilters): Promise<AdminRequestList> {
  const stats = await getRequestStats();
  const limit = filters.limit ?? 25;
  const query: Record<string, unknown> = {};
  if (filters.q) query.publicRequestId = filters.q;
  if (filters.status) query.status = filters.status;
  if (filters.bloodGroup) query.bloodGroup = filters.bloodGroup;
  if (filters.city) query.cityNormalized = normalise(filters.city);
  if (filters.cursor && Types.ObjectId.isValid(filters.cursor)) query._id = { $lt: new Types.ObjectId(filters.cursor) };

  const docs = (await EmergencyRequest.find(query).sort({ _id: -1 }).limit(limit + 1).lean()) as RequestRecord[];
  const page = docs.slice(0, limit);
  return {
    stats,
    requests: page.map(toSummary),
    nextCursor: docs.length > limit ? page[page.length - 1]._id.toString() : null,
  };
}

/** Full details for verification, including decrypted contact details. Every view is audited. */
export async function getAdminRequestDetail(publicRequestId: string, adminUserId: Types.ObjectId, ctx: { requestId: string }): Promise<AdminRequestDetail> {
  await connectToDatabase();
  await expireOverdueRequests();
  const r = (await EmergencyRequest.findOne({ publicRequestId }).lean()) as RequestRecord | null;
  if (!r) throw notFound();
  const links = (await RequestShareLink.find({ requestId: r._id }).sort({ createdAt: -1 }).limit(50).lean()) as LinkRecord[];
  await recordAudit({ action: "request.viewed_by_admin", outcome: "success", requestId: ctx.requestId, actorUserId: adminUserId, resourceType: "emergency_request", resourceId: r.publicRequestId });
  const coords = r.location?.coordinates;
  return {
    ...toSummary(r),
    patientName: decryptPii(r.patientNameEncrypted),
    patientAge: r.patientAge ?? null,
    contactName: decryptPii(r.contactNameEncrypted),
    contactPhone: decryptPii(r.contactPhoneEncrypted),
    hospitalAddress: r.hospitalAddress,
    hospitalPhone: r.hospitalPhone ?? null,
    location: coords?.length === 2 ? { longitude: coords[0], latitude: coords[1] } : null,
    verifiedAt: iso(r.verifiedAt),
    whatsappUpdates: r.whatsappUpdates,
    consentAcceptedAt: (r.consent?.sharingAcceptedAt ?? r.createdAt).toISOString(),
    privacyNoticeVersion: r.consent?.privacyNoticeVersion ?? "unknown",
    expiresAt: r.expiresAt.toISOString(),
    closedAt: iso(r.closedAt),
    history: r.history.map((h) => ({ status: h.status, at: h.at.toISOString(), actor: h.actor, note: h.note ?? null })),
    allowedStatuses: allowedTransitions("admin", r.status),
    links: links.map((l) => ({
      id: l._id.toString(),
      scope: l.scope,
      createdBy: l.createdBy,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      revoked: Boolean(l.revokedAt),
    })),
  };
}

export async function adminUpdateStatus(publicRequestId: string, status: RequestStatus, note: string | undefined, adminUserId: Types.ObjectId, ctx: ApiContext) {
  await connectToDatabase();
  await expireOverdueRequests();
  const r = (await EmergencyRequest.findOne({ publicRequestId }).lean()) as RequestRecord | null;
  if (!r) throw notFound();
  await applyTransition(r, status, { type: "admin", userId: adminUserId, note }, ctx);
}

export async function adminRevokeLink(publicRequestId: string, linkId: string, adminUserId: Types.ObjectId, ctx: ApiContext) {
  await connectToDatabase();
  const r = await EmergencyRequest.findOne({ publicRequestId }, { _id: 1 }).lean();
  if (!r || !Types.ObjectId.isValid(linkId)) throw notFound();
  const result = await RequestShareLink.updateOne({ _id: linkId, requestId: r._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (result.matchedCount !== 1) throw notFound();
  await recordAudit({ action: "request.link_revoked", outcome: "success", requestId: ctx.requestId, actorUserId: adminUserId, resourceType: "emergency_request", resourceId: publicRequestId });
}
