import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import type { addContactSchema, channelUpdateSchema, ChannelStatus, ContactStatus, createInstitutionSchema, InstitutionStatus, ReviewStatus } from "@/features/coordination/schemas";
import type { InstitutionDetail, InstitutionSummary } from "@/features/coordination/types";
import { OPEN_STATUSES } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { normalisePlace } from "@/server/matching/engine";
import { AvailabilityReport } from "@/server/models/availability-report";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution, type InstitutionDoc } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";
import { recordAudit } from "@/server/services/audit";

/**
 * Institution verification and contacts, managed only by admins. A contact's
 * number gives institutional access on WhatsApp only while both the contact
 * and its institution are verified.
 */

type InstitutionRecord = InstitutionDoc & { _id: Types.ObjectId; createdAt: Date };
const notFound = () => new AppError(404, "NOT_FOUND", "Institution not found.");
const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;
const iso = (d?: Date | null) => (d ? d.toISOString() : null);

async function loadInstitution(id: string): Promise<InstitutionRecord> {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const doc = (await Institution.findById(id).lean()) as InstitutionRecord | null;
  if (!doc) throw notFound();
  return doc;
}

async function toSummary(doc: InstitutionRecord): Promise<InstitutionSummary> {
  return {
    id: doc._id.toString(),
    type: doc.type,
    displayName: doc.displayName,
    city: doc.city,
    locality: doc.locality,
    verificationStatus: doc.verificationStatus,
    verifiedContacts: await InstitutionContact.countDocuments({ institutionId: doc._id, status: "verified" }),
    createdAt: doc.createdAt.toISOString(),
    source: doc.source ?? "admin",
    reviewStatus: doc.review?.status ?? "approved",
    capability: doc.capability ?? "hospital",
    contactChannels: (doc.contactChannels ?? []).filter((c) => c.status !== "invalid").length,
  };
}

export async function createInstitution(input: z.output<typeof createInstitutionSchema>, adminUserId: Types.ObjectId, requestId: string): Promise<InstitutionSummary> {
  await connectToDatabase();
  const doc = await Institution.create({
    type: input.type,
    legalName: input.legalName,
    displayName: input.displayName,
    address: input.address,
    city: input.city,
    cityNormalized: normalisePlace(input.city),
    locality: input.locality,
    ...(input.publicPhone ? { publicPhone: input.publicPhone } : {}),
    ...(input.licenceReference ? { licenceReferenceEncrypted: encryptPii(input.licenceReference) } : {}),
    verificationStatus: "pending",
    createdBy: adminUserId,
    source: "admin",
    capability: input.type === "blood_bank" ? "blood_bank" : "hospital",
    capabilitySource: "admin",
    review: { status: "approved", reviewedAt: new Date(), reviewedBy: adminUserId },
    contactChannels: input.publicPhone
      ? [{ type: "phone", value: input.publicPhone, source: "admin", retrievedAt: new Date(), status: "verified", statusChangedAt: new Date(), statusChangedBy: adminUserId }]
      : [],
  });
  await recordAudit({ action: "institution.created", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution", resourceId: doc._id.toString() });
  return toSummary(doc.toObject() as InstitutionRecord);
}

export async function listInstitutions(filter: { status?: InstitutionStatus; review?: ReviewStatus } = {}): Promise<InstitutionSummary[]> {
  await connectToDatabase();
  const query: Record<string, unknown> = {};
  if (filter.status) query.verificationStatus = filter.status;
  if (filter.review) query["review.status"] = filter.review;
  const docs = (await Institution.find(query).sort({ createdAt: -1 }).limit(200).lean()) as InstitutionRecord[];
  return Promise.all(docs.map(toSummary));
}

export async function getInstitutionDetail(id: string): Promise<InstitutionDetail> {
  await connectToDatabase();
  const doc = await loadInstitution(id);
  const [contacts, reports, requests] = await Promise.all([
    InstitutionContact.find({ institutionId: doc._id }).sort({ createdAt: 1 }).lean(),
    AvailabilityReport.find({ institutionId: doc._id }).sort({ reportedAt: -1 }).limit(20).lean(),
    EmergencyRequest.find({ institutionId: doc._id, status: { $in: OPEN_STATUSES } }, { publicRequestId: 1, status: 1, bloodGroup: 1, institutionAcknowledgedAt: 1 }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const contactName = new Map(contacts.map((c) => [c._id.toString(), decryptPii(c.nameEncrypted)]));
  return {
    ...(await toSummary(doc)),
    legalName: doc.legalName,
    address: doc.address,
    publicPhone: doc.publicPhone ?? null,
    licenceReference: doc.licenceReferenceEncrypted ? decryptPii(doc.licenceReferenceEncrypted) : null,
    verifiedAt: iso(doc.verifiedAt),
    statusNote: doc.statusNote ?? null,
    contacts: contacts.map((c) => ({
      id: c._id.toString(),
      name: decryptPii(c.nameEncrypted),
      maskedPhone: maskPhone(decryptPii(c.phoneEncrypted)),
      role: c.role,
      status: c.status,
      verifiedAt: iso(c.verifiedAt),
    })),
    availability: reports.map((r) => ({
      id: r._id.toString(),
      bloodGroup: r.bloodGroup,
      component: r.component,
      status: r.status,
      units: r.units ?? null,
      reportedAt: r.reportedAt.toISOString(),
      reportedBy: contactName.get(r.contactId.toString()) ?? "Former contact",
    })),
    externalRefs: (doc.externalRefs ?? []).map((ref) => ({ ref, url: ref.startsWith("osm:") ? `https://www.openstreetmap.org/${ref.slice(4)}` : null })),
    capabilitySource: doc.capabilitySource ?? "admin",
    review: { status: doc.review?.status ?? "approved", reviewedAt: iso(doc.review?.reviewedAt), note: doc.review?.note ?? null },
    discoveredAt: iso(doc.discoveredAt),
    lastSeenAt: iso(doc.lastSeenAt),
    channels: (doc.contactChannels ?? []).map((c) => ({ id: c._id.toString(), type: c.type, value: c.value, status: c.status, source: c.source, sourceUrl: c.sourceUrl ?? null, retrievedAt: c.retrievedAt.toISOString() })),
    openRequests: requests.map((r) => ({ publicRequestId: r.publicRequestId, status: r.status, bloodGroup: r.bloodGroup, acknowledgedAt: iso(r.institutionAcknowledgedAt) })),
  };
}

export async function setInstitutionStatus(id: string, status: InstitutionStatus, note: string | undefined, adminUserId: Types.ObjectId, requestId: string) {
  await connectToDatabase();
  const doc = await loadInstitution(id);
  const $set: Record<string, unknown> = { verificationStatus: status, ...(note ? { statusNote: note } : {}) };
  if (status === "verified") Object.assign($set, { verifiedAt: new Date(), verifiedBy: adminUserId });
  await Institution.updateOne({ _id: doc._id }, { $set });
  await recordAudit({ action: "institution.status_changed", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution", resourceId: `${id}:${doc.verificationStatus}->${status}` });
}

export async function addContact(id: string, input: z.output<typeof addContactSchema>, adminUserId: Types.ObjectId, requestId: string) {
  await connectToDatabase();
  const doc = await loadInstitution(id);
  try {
    // Added as pending: an admin must verify the person separately before the number gets access.
    await InstitutionContact.create({
      institutionId: doc._id,
      nameEncrypted: encryptPii(input.name),
      phoneLookup: phoneLookupToken(input.phone),
      phoneEncrypted: encryptPii(input.phone),
      role: input.role,
      status: "pending",
      createdBy: adminUserId,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError(409, "PHONE_IN_USE", "This number is already linked to an institution.");
    throw error;
  }
  await recordAudit({ action: "institution.contact_added", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution", resourceId: id });
}

export async function setContactStatus(id: string, contactId: string, status: ContactStatus, adminUserId: Types.ObjectId, requestId: string) {
  await connectToDatabase();
  const doc = await loadInstitution(id);
  if (!Types.ObjectId.isValid(contactId)) throw notFound();
  const now = new Date();
  const $set: Record<string, unknown> = { status };
  if (status === "verified") Object.assign($set, { verifiedAt: now, verifiedBy: adminUserId });
  if (status === "revoked") $set.revokedAt = now;
  const result = await InstitutionContact.updateOne({ _id: contactId, institutionId: doc._id }, { $set });
  if (result.matchedCount !== 1) throw notFound();
  await recordAudit({ action: "institution.contact_status_changed", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution_contact", resourceId: `${contactId}:${status}` });
}

/** Links a request to the verified institution coordinating it (or unlinks it). */
export async function linkRequestInstitution(publicRequestId: string, institutionId: string | null, adminUserId: Types.ObjectId, requestId: string) {
  await connectToDatabase();
  const request = await EmergencyRequest.findOne({ publicRequestId }, { _id: 1 }).lean();
  if (!request) throw new AppError(404, "NOT_FOUND", "We couldn't find that request.");
  if (institutionId) {
    const institution = await loadInstitution(institutionId);
    if (institution.verificationStatus !== "verified") {
      throw new AppError(409, "INSTITUTION_NOT_VERIFIED", "Only verified institutions can be linked to a request.");
    }
    await EmergencyRequest.updateOne({ _id: request._id }, { $set: { institutionId: institution._id }, $unset: { institutionAcknowledgedAt: 1, institutionAcknowledgedBy: 1 } });
  } else {
    await EmergencyRequest.updateOne({ _id: request._id }, { $unset: { institutionId: 1, institutionAcknowledgedAt: 1, institutionAcknowledgedBy: 1 } });
  }
  await recordAudit({ action: "request.institution_linked", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "emergency_request", resourceId: `${publicRequestId}:${institutionId ?? "none"}` });
}

/** Admin review of a (usually discovered) institution: relevant and official, or excluded. */
export async function reviewInstitution(id: string, status: "approved" | "excluded", note: string | undefined, adminUserId: Types.ObjectId, requestId: string) {
  await connectToDatabase();
  const doc = await loadInstitution(id);
  await Institution.updateOne({ _id: doc._id }, { $set: { review: { status, reviewedAt: new Date(), reviewedBy: adminUserId, ...(note ? { note } : {}) } } });
  await recordAudit({ action: "institution.reviewed", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution", resourceId: `${id}:${status}` });
}

/** Adds a contact channel, or corrects an existing one. An admin edit is recorded as source "admin". */
export async function upsertChannel(id: string, channelId: string | null, input: z.output<typeof channelUpdateSchema>, adminUserId: Types.ObjectId, requestId: string) {
  await connectToDatabase();
  const doc = await loadInstitution(id);
  const now = new Date();
  if (channelId) {
    if (!Types.ObjectId.isValid(channelId)) throw notFound();
    const current = doc.contactChannels.find((c) => c._id.toString() === channelId);
    if (!current) throw notFound();
    const changed = current.value !== input.value || current.type !== input.type;
    await Institution.updateOne(
      { _id: doc._id, "contactChannels._id": current._id },
      {
        $set: {
          "contactChannels.$.type": input.type,
          "contactChannels.$.value": input.value,
          "contactChannels.$.status": input.status,
          "contactChannels.$.statusChangedAt": now,
          "contactChannels.$.statusChangedBy": adminUserId,
          ...(changed ? { "contactChannels.$.source": "admin", "contactChannels.$.retrievedAt": now, "contactChannels.$.sourceUrl": null } : {}),
        },
      },
    );
  } else {
    if (doc.contactChannels.some((c) => c.type === input.type && c.value.toLowerCase() === input.value.toLowerCase())) {
      throw new AppError(409, "CONFLICT", "That contact is already recorded.");
    }
    await Institution.updateOne(
      { _id: doc._id },
      { $push: { contactChannels: { type: input.type, value: input.value, source: "admin", retrievedAt: now, status: input.status, statusChangedAt: now, statusChangedBy: adminUserId } } },
    );
  }
  await recordAudit({ action: "institution.channel_changed", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution", resourceId: `${id}:${channelId ?? "new"}:${input.type}:${input.status}` });
}

export async function setChannelStatus(id: string, channelId: string, status: ChannelStatus, adminUserId: Types.ObjectId, requestId: string) {
  await connectToDatabase();
  const doc = await loadInstitution(id);
  if (!Types.ObjectId.isValid(channelId)) throw notFound();
  const result = await Institution.updateOne(
    { _id: doc._id, "contactChannels._id": new Types.ObjectId(channelId) },
    { $set: { "contactChannels.$.status": status, "contactChannels.$.statusChangedAt": new Date(), "contactChannels.$.statusChangedBy": adminUserId } },
  );
  if (result.matchedCount !== 1) throw notFound();
  await recordAudit({ action: "institution.channel_changed", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution", resourceId: `${id}:${channelId}:${status}` });
}
