import "server-only";
import { randomUUID } from "node:crypto";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { connectToDatabase } from "@/lib/db/mongoose";
import { phoneLookupToken } from "@/lib/security/crypto";
import { ConsentRecord } from "@/server/models/consent-record";
import { DonorProfile } from "@/server/models/donor-profile";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { recordAudit } from "@/server/services/audit";

/**
 * Honours an opt-out immediately: adds the number to the suppression list,
 * withdraws donor alert consent, suppresses queued messages and cancels any
 * WhatsApp onboarding in progress.
 */
export async function recordOptOut(
  phoneE164: string,
  source: "whatsapp_stop" | "user" | "admin",
  now = new Date(),
): Promise<void> {
  await connectToDatabase();
  const phoneLookup = phoneLookupToken(phoneE164);

  await MessagingOptOut.updateOne(
    { phoneLookup, channel: "whatsapp" },
    { $setOnInsert: { phoneLookup, channel: "whatsapp", source, optedOutAt: now } },
    { upsert: true },
  );

  const user = await User.findOne({ phoneLookup }, { _id: 1 }).lean();
  if (user) {
    const withdrawn = await DonorProfile.updateOne(
      { userId: user._id, notificationConsentAt: { $ne: null }, notificationConsentWithdrawnAt: null },
      { $set: { notificationConsentWithdrawnAt: now }, $unset: { notificationsPausedAt: 1 } },
    );
    if (withdrawn.modifiedCount === 1) {
      await ConsentRecord.create({
        userId: user._id,
        purpose: "donor_alerts",
        channel: "whatsapp",
        action: "withdrawn",
        source: source === "whatsapp_stop" ? "whatsapp" : "web",
        noticeVersion: PRIVACY_NOTICE_VERSION,
      });
    }
  }

  await NotificationEvent.updateMany(
    { recipientLookup: phoneLookup, status: "queued", kind: { $ne: "opt_out_confirmation" } },
    { $set: { status: "suppressed", failureCode: "OPTED_OUT", failedAt: now }, $unset: { bodyEncrypted: 1 } },
  );

  await WhatsAppConversation.updateOne(
    { phoneLookup, status: "active" },
    { $set: { status: "cancelled", cancelledAt: now }, $inc: { version: 1 } },
  );

  await recordAudit({
    action: "messaging.opt_out_recorded",
    outcome: "success",
    requestId: randomUUID(),
    actorUserId: user?._id,
    resourceType: "messaging_opt_out",
  });
}

/**
 * Removes a number from the suppression list. Call this only after an explicit
 * action by the person: JOIN on WhatsApp, or an authenticated choice in the
 * app. Alert consent is not restored; it must be given again.
 */
export async function liftOptOut(phoneE164: string, via: "whatsapp_join" | "app"): Promise<boolean> {
  await connectToDatabase();
  const phoneLookup = phoneLookupToken(phoneE164);
  const removed = await MessagingOptOut.deleteOne({ phoneLookup, channel: "whatsapp" });
  if (removed.deletedCount === 1) {
    const user = await User.findOne({ phoneLookup }, { _id: 1 }).lean();
    await recordAudit({
      action: "messaging.opt_out_lifted",
      outcome: "success",
      requestId: randomUUID(),
      actorUserId: user?._id,
      resourceType: "messaging_opt_out",
      resourceId: via,
    });
  }
  return removed.deletedCount === 1;
}
