import "server-only";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, generateTrackingToken, hashTrackingToken } from "@/lib/security/crypto";
import { recordEvent } from "@/server/coordination/events";
import { enqueueMessage } from "@/server/messaging/queue";
import { ContactAccessLog } from "@/server/models/contact-access-log";
import { DonorProfile } from "@/server/models/donor-profile";
import type { EmergencyRequestDoc } from "@/server/models/emergency-request";
import { RequestResponse } from "@/server/models/request-response";
import { RequestShareLink } from "@/server/models/request-share-link";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";

/**
 * Connecting the requester with donors who agreed to share their contact.
 *
 * Disclosure rules:
 * - Only donors who replied INTERESTED and then said YES to sharing are disclosed.
 * - WhatsApp messages carry donor details only to a requester number that
 *   WhatsApp itself authenticated (requests created on WhatsApp). A number
 *   typed into the web form may be mistyped, so it only gets a nudge to open
 *   the private manage link.
 * - On the web, details appear behind the manage link (or a short-lived link
 *   the requester creates for one responsible person). Every disclosure is
 *   written to `contact_access_logs`.
 */

type RequestRecord = EmergencyRequestDoc & { _id: Types.ObjectId };

export interface DisclosedDonor {
  responseId: string;
  firstName: string;
  bloodGroup: string;
  area: string;
  phone: string;
}

async function disclosable(responseId: Types.ObjectId | string, requestId: Types.ObjectId) {
  const response = await RequestResponse.findOne({ _id: responseId, requestId, response: "interested", contactSharingConsentAt: { $ne: null } }).lean();
  if (!response || response.coordinationStatus === "not_proceeding") return null;
  const [user, profile] = await Promise.all([
    User.findById(response.donorUserId, { displayName: 1, phoneEncrypted: 1, status: 1 }).lean(),
    DonorProfile.findOne({ userId: response.donorUserId }, { bloodGroup: 1, locality: 1, city: 1 }).lean(),
  ]);
  if (!user || user.status !== "active" || !profile) return null;
  return {
    response,
    donor: {
      responseId: response._id.toString(),
      firstName: user.displayName?.split(" ")[0] ?? "Donor",
      bloodGroup: profile.bloodGroup === "unknown" ? "Not sure" : BLOOD_GROUP_LABELS[profile.bloodGroup],
      area: `${profile.locality}, ${profile.city}`,
      phone: decryptPii(user.phoneEncrypted),
    } satisfies DisclosedDonor,
  };
}

async function logAccess(entry: { requestId: Types.ObjectId; responseId?: Types.ObjectId; donorUserId?: Types.ObjectId; action: "revealed" | "sent_by_whatsapp" | "share_link_created" | "share_link_viewed" | "share_link_revoked"; via: "manage_link" | "donor_contacts_link" | "whatsapp" | "admin"; linkId?: Types.ObjectId }) {
  await ContactAccessLog.create({ ...entry, at: new Date() });
}

/**
 * Tells the requester a donor responded. Runs once per response (guarded by
 * `requesterNotifiedAt`), whatever the donor answered about sharing.
 */
export async function notifyRequesterOfDonor(request: RequestRecord, responseId: Types.ObjectId, now = new Date()): Promise<"whatsapp_with_contact" | "whatsapp_nudge" | "web_only" | "already_notified"> {
  const claimed = await RequestResponse.updateOne({ _id: responseId, requesterNotifiedAt: null }, { $set: { requesterNotifiedAt: now } });
  if (claimed.modifiedCount !== 1) return "already_notified";

  const found = await disclosable(responseId, request._id);
  await recordEvent(request._id, found ? "donor_contact_shared" : "donor_interested", found ? `A registered donor (${found.donor.firstName}) agreed to share their contact. Interest isn't a confirmed donation.` : "A registered donor said they can help. The MarutiX team will coordinate with them.", { visibleToRequester: true, actor: "donor", at: now });

  // A genuine requester number: WhatsApp authenticated it when they created the request there.
  if (request.createdVia === "whatsapp" && request.requesterPhoneEncrypted) {
    const body = found
      ? [
          "Good news! A donor has responded to your emergency request.",
          "",
          `Donor name: ${found.donor.firstName}`,
          `Blood group (self-reported): ${found.donor.bloodGroup}`,
          `Area: ${found.donor.area}`,
          `Contact: ${found.donor.phone}`,
          "",
          "Please coordinate with the donor and your hospital's blood bank. The blood centre decides whether they can donate; a donor's interest isn't a confirmed donation.",
          `Request ID: ${request.publicRequestId}`,
        ].join("\n")
      : `A registered donor said they can help with ${request.publicRequestId}. They chose to keep their number private, so the MarutiX team will coordinate with them. Keep working with the hospital's blood bank.`;
    const result = await enqueueMessage({
      kind: "requester_update",
      templateName: "requester_donor_update_v1",
      phoneE164: decryptPii(request.requesterPhoneEncrypted),
      body,
      idempotencyKey: `requester_update:donor:${responseId.toString()}`,
      requestId: request._id.toString(),
      recordSuppressed: true,
    });
    if (result.outcome === "queued" && found) await logAccess({ requestId: request._id, responseId, donorUserId: found.response.donorUserId, action: "sent_by_whatsapp", via: "whatsapp" });
    return found ? "whatsapp_with_contact" : "whatsapp_nudge";
  }
  if (request.whatsappUpdates) {
    await enqueueMessage({
      kind: "requester_update",
      templateName: "requester_donor_nudge_v1",
      phoneE164: decryptPii(request.contactPhoneEncrypted),
      body: `MarutiX: a registered donor has responded to ${request.publicRequestId}. Open the private tracking link you saved when you made the request to see the details. Keep working with the hospital's blood bank.`,
      idempotencyKey: `requester_update:donor:${responseId.toString()}`,
      requestId: request._id.toString(),
      recordSuppressed: true,
    });
    return "whatsapp_nudge";
  }
  return "web_only";
}

/** Manage link: show one consenting donor's contact. Logged every time. */
export async function revealDonorContact(request: RequestRecord, responseId: string): Promise<DisclosedDonor> {
  await connectToDatabase();
  if (!Types.ObjectId.isValid(responseId)) throw new AppError(404, "NOT_FOUND", "We couldn't find that donor response.");
  const found = await disclosable(responseId, request._id);
  if (!found) throw new AppError(404, "NOT_FOUND", "This donor hasn't agreed to share their contact.");
  await logAccess({ requestId: request._id, responseId: found.response._id, donorUserId: found.response.donorUserId, action: "revealed", via: "manage_link" });
  await recordAudit({ action: "donor_contact.revealed", outcome: "success", requestId: randomUUID(), resourceType: "request_response", resourceId: `${request.publicRequestId}:${responseId}` });
  return found.donor;
}

/** The requester reports they contacted a donor. A separate state from interest and donation. */
export async function markDonorContacted(request: RequestRecord, responseId: string, now = new Date()) {
  await connectToDatabase();
  if (!Types.ObjectId.isValid(responseId)) throw new AppError(404, "NOT_FOUND", "We couldn't find that donor response.");
  const result = await RequestResponse.updateOne({ _id: responseId, requestId: request._id, response: "interested", requesterContactedAt: null }, { $set: { requesterContactedAt: now } });
  if (result.matchedCount !== 1 && !(await RequestResponse.exists({ _id: responseId, requestId: request._id }))) {
    throw new AppError(404, "NOT_FOUND", "We couldn't find that donor response.");
  }
  await recordAudit({ action: "donor_contact.marked_contacted", outcome: "success", requestId: randomUUID(), resourceType: "request_response", resourceId: `${request.publicRequestId}:${responseId}` });
}

/** A short-lived link showing consenting donors' contacts to one responsible person. */
export async function createDonorContactsLink(request: RequestRecord, manageLinkExpiresAt: Date, hours: number, now = new Date()) {
  await connectToDatabase();
  const expiresAt = new Date(Math.min(now.getTime() + hours * 60 * 60 * 1000, manageLinkExpiresAt.getTime()));
  const token = generateTrackingToken();
  const link = await RequestShareLink.create({ requestId: request._id, tokenHash: hashTrackingToken(token), scope: "donor_contacts", createdBy: "requester", expiresAt });
  await logAccess({ requestId: request._id, action: "share_link_created", via: "manage_link", linkId: link._id });
  await recordAudit({ action: "donor_contact.link_created", outcome: "success", requestId: randomUUID(), resourceType: "emergency_request", resourceId: request.publicRequestId });
  return { id: link._id.toString(), token, expiresAt };
}

/** Consenting donors' contacts for a manage or donor_contacts link. Logs a view per donor shown when `logAs` is set. */
export async function disclosedDonors(request: RequestRecord, logAs?: { via: "donor_contacts_link"; linkId: Types.ObjectId }): Promise<DisclosedDonor[]> {
  const responses = await RequestResponse.find({ requestId: request._id, response: "interested", contactSharingConsentAt: { $ne: null } }, { _id: 1 }).sort({ respondedAt: 1 }).limit(20).lean();
  const donors: DisclosedDonor[] = [];
  for (const r of responses) {
    const found = await disclosable(r._id, request._id);
    if (!found) continue;
    donors.push(found.donor);
    if (logAs) await logAccess({ requestId: request._id, responseId: found.response._id, donorUserId: found.response.donorUserId, action: "share_link_viewed", via: logAs.via, linkId: logAs.linkId });
  }
  if (logAs && donors.length) await recordAudit({ action: "donor_contact.link_viewed", outcome: "success", requestId: randomUUID(), resourceType: "emergency_request", resourceId: `${request.publicRequestId}:${donors.length}` });
  return donors;
}

export async function contactAccessCount(requestId: Types.ObjectId): Promise<number> {
  return ContactAccessLog.countDocuments({ requestId });
}

