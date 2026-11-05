import "server-only";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { AppError } from "@/lib/api/errors";
import { isStaffRole } from "@/lib/auth/permissions";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii } from "@/lib/security/crypto";
import { recordOptOut } from "@/server/messaging/opt-out";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { NotificationEvent } from "@/server/models/notification-event";
import { OtpChallenge } from "@/server/models/otp-challenge";
import { RequestResponse } from "@/server/models/request-response";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";
import { OPEN_STATUSES } from "@/features/requests/schemas";
import { recordAudit } from "@/server/services/audit";
import { revokeAllSessions } from "@/server/services/session";

/** Coordination states a donor can still walk away from. A confirmed donation stays on record. */
const WITHDRAWABLE = ["interested", "coordinator_contacted", "hospital_coordination", "donor_arrived"] as const;

export interface DeletionSummary {
  donorProfileDeleted: boolean;
  responsesWithdrawn: number;
  messagesErased: number;
  sessionsEnded: number;
}

/**
 * Deletes a person's account after a fresh OTP check (done by the caller).
 *
 * Deleted: donor profile, WhatsApp conversation state, OTP challenges.
 * Anonymised: the user record becomes a tombstone (no phone, no name; a random
 *   lookup so the number can sign up again as a new account); stored messages
 *   lose the recipient number, body and template values.
 * Withdrawn: alert consent (a "withdrawn" consent record is appended), contact
 *   sharing on every response, and active donor responses on open requests.
 * Retained, with no personal data: the opt-out entry (a keyed hash, so the
 *   number is never alerted again), consent history, audit and access logs,
 *   and confirmed donations (the patient's record).
 * Emergency requests are not tied to accounts and are not changed here; closed
 *   requests are anonymised by the retention job.
 */
export async function deleteAccount(userId: string | Types.ObjectId, requestId: string, now = new Date()): Promise<DeletionSummary> {
  await connectToDatabase();
  const id = typeof userId === "string" ? new Types.ObjectId(userId) : userId;
  const user = await User.findById(id).lean();
  if (!user || user.status === "deleted") throw new AppError(404, "NOT_FOUND", "This account no longer exists.");
  if (isStaffRole(user.role)) {
    throw new AppError(409, "STAFF_ACCOUNT", "Admin accounts can't be deleted here. Ask a super admin to remove your admin access first.");
  }
  const phoneLookup = user.phoneLookup;

  await recordAudit({ action: "account.deletion_requested", outcome: "success", requestId, actorUserId: id, resourceType: "user" });

  // 1. Stop all messaging first: opt-out suppresses queued messages, withdraws consent and cancels conversations.
  await recordOptOut(decryptPii(user.phoneEncrypted), "user", now);

  // 2. Withdraw from open requests so coordinators stop relying on this donor.
  const openRequestIds = (await EmergencyRequest.find({ status: { $in: OPEN_STATUSES } }, { _id: 1 }).lean()).map((r) => r._id);
  const withdrawn = await RequestResponse.updateMany(
    { donorUserId: id, requestId: { $in: openRequestIds }, coordinationStatus: { $in: WITHDRAWABLE } },
    {
      $set: { coordinationStatus: "not_proceeding" },
      $push: { coordinationHistory: { status: "not_proceeding", at: now, actor: "donor", actorUserId: id, note: "Donor deleted their MarutiX account" } },
    },
  );
  // Nobody may see this person's contact details any more, on any request.
  await RequestResponse.updateMany({ donorUserId: id, contactSharingConsentAt: { $ne: null } }, { $set: { contactSharingDeclinedAt: now }, $unset: { contactSharingConsentAt: 1 } });

  // 3. Erase the number and content from stored messages; nothing pending may be sent or retried.
  await NotificationEvent.updateMany(
    { $or: [{ recipientUserId: id }, { recipientLookup: phoneLookup }], status: { $in: ["queued", "sending"] } },
    { $set: { status: "suppressed", failureCode: "ACCOUNT_DELETED", failedAt: now } },
  );
  await NotificationEvent.updateMany({ $or: [{ recipientUserId: id }, { recipientLookup: phoneLookup }], status: "failed" }, { $set: { failureCode: "ACCOUNT_DELETED" } });
  const erased = await NotificationEvent.updateMany(
    { $or: [{ recipientUserId: id }, { recipientLookup: phoneLookup }] },
    { $set: { recipientLookup: `deleted:${id.toString()}` }, $unset: { recipientPhoneEncrypted: 1, bodyEncrypted: 1, templateParamsEncrypted: 1 } },
  );

  // 4. Delete profile data and short-lived records.
  const profile = await DonorProfile.deleteOne({ userId: id });
  await WhatsAppConversation.deleteMany({ $or: [{ phoneLookup }, { userId: id }] });
  await OtpChallenge.deleteMany({ phoneLookup });
  await WhatsAppInboundMessage.updateMany({ phoneLookup }, { $unset: { phoneLookup: 1 } });

  // 5. Tombstone the account and end every session.
  await User.updateOne(
    { _id: id },
    {
      $set: { status: "deleted", deletedAt: now, phoneLookup: `deleted:${randomUUID()}`, phoneEncrypted: encryptPii("deleted") },
      $unset: { displayName: 1, mfa: 1 },
    },
  );
  const sessionsEnded = await revokeAllSessions(id, "account_deleted");

  await recordAudit({ action: "account.deleted", outcome: "success", requestId, actorUserId: id, resourceType: "user" });
  return { donorProfileDeleted: profile.deletedCount === 1, responsesWithdrawn: withdrawn.modifiedCount, messagesErased: erased.modifiedCount, sessionsEnded };
}
