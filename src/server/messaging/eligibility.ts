import "server-only";
import type { Types } from "mongoose";
import { Types as MongooseTypes } from "mongoose";
import { ALERTABLE_STATUSES } from "@/features/coordination/schemas";
import type { MessageKind, MessageStatus } from "@/features/whatsapp/types";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { User } from "@/server/models/user";

export type IneligibleReason =
  | "OPTED_OUT"
  | "NO_ACCOUNT"
  | "ACCOUNT_INACTIVE"
  | "NO_CONSENT"
  | "PAUSED"
  | "NOT_AVAILABLE"
  | "NOT_TEST_RECIPIENT"
  | "REQUEST_NOT_ALERTABLE"
  | "FREQUENCY_CAP"
  | "NOT_VERIFIED_INSTITUTION";

export type Eligibility = { ok: true; recipientUserId?: Types.ObjectId } | { ok: false; reason: IneligibleReason };

interface EligibilityInput {
  kind: MessageKind;
  phoneE164: string;
  phoneLookup: string;
  recipientUserId?: Types.ObjectId;
  testRecipients: Set<string>;
  /** The emergency request an alert is about (emergency_request, coordinator_alert). */
  requestId?: string | null;
  /** "enqueue" counts queued alerts towards the daily cap; "dispatch" counts only sent ones. */
  stage?: "enqueue" | "dispatch";
}

/** Alerts only for a request that still exists, is verified and active, and hasn't expired. */
async function requestAlertable(requestId: string | null | undefined, now = new Date()): Promise<boolean> {
  if (!requestId || !MongooseTypes.ObjectId.isValid(requestId)) return false;
  const request = await EmergencyRequest.findById(requestId, { status: 1, expiresAt: 1 }).lean();
  return Boolean(request && (ALERTABLE_STATUSES as readonly string[]).includes(request.status) && request.expiresAt > now);
}

/** No donor gets more than ALERT_MAX_PER_DONOR_PER_DAY emergency alerts in 24 hours. */
async function underDailyCap(phoneLookup: string, stage: "enqueue" | "dispatch", now = new Date()): Promise<boolean> {
  const statuses: MessageStatus[] = stage === "enqueue" ? ["queued", "sending", "sent", "delivered", "read"] : ["sent", "delivered", "read"];
  const count = await NotificationEvent.countDocuments({
    recipientLookup: phoneLookup,
    kind: "emergency_request",
    status: { $in: statuses },
    createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
  });
  return count < getCoordinationConfig().alertMaxPerDonorPerDay;
}

/** A verified contact of a verified institution. A number alone never qualifies. */
export async function verifiedInstitutionContact(phoneLookup: string) {
  const contact = await InstitutionContact.findOne({ phoneLookup, status: "verified" }).lean();
  if (!contact) return null;
  const institution = await Institution.findOne({ _id: contact.institutionId, verificationStatus: "verified" }).lean();
  return institution ? { contact, institution } : null;
}

export async function isOptedOut(phoneLookup: string): Promise<boolean> {
  return (await MessagingOptOut.exists({ phoneLookup, channel: "whatsapp" })) !== null;
}

/**
 * A donor may receive alerts only with recorded, unwithdrawn WhatsApp
 * consent that isn't paused.
 */
async function donorConsent(
  phoneLookup: string,
  recipientUserId: Types.ObjectId | undefined,
  { requireAvailability, allowPaused }: { requireAvailability: boolean; allowPaused: boolean },
): Promise<Eligibility> {
  const user = recipientUserId
    ? await User.findById(recipientUserId).lean()
    : await User.findOne({ phoneLookup }).lean();
  if (!user) return { ok: false, reason: "NO_ACCOUNT" };
  if (user.phoneLookup !== phoneLookup) return { ok: false, reason: "NO_ACCOUNT" };
  if (user.status !== "active") return { ok: false, reason: "ACCOUNT_INACTIVE" };

  const profile = await DonorProfile.findOne({ userId: user._id }).lean();
  const consented =
    profile?.notificationConsentAt &&
    !profile.notificationConsentWithdrawnAt &&
    profile.notificationChannels.includes("whatsapp");
  if (!consented) return { ok: false, reason: "NO_CONSENT" };
  if (!allowPaused && profile.notificationsPausedAt) return { ok: false, reason: "PAUSED" };
  if (requireAvailability && !profile.availableForRequests) return { ok: false, reason: "NOT_AVAILABLE" };
  return { ok: true, recipientUserId: user._id };
}

/**
 * Single source of truth for "may we message this number?". Called when a
 * message is queued and again immediately before it is sent.
 */
export async function checkEligibility(input: EligibilityInput): Promise<Eligibility> {
  // An opt-out confirmation is the one message allowed after STOP.
  if (input.kind === "opt_out_confirmation") return { ok: true, recipientUserId: input.recipientUserId };
  if (await isOptedOut(input.phoneLookup)) return { ok: false, reason: "OPTED_OUT" };

  switch (input.kind) {
    case "help_reply":
    case "bot_reply":
    case "request_confirmation":
      // Replies in a conversation the person started, or a confirmation the requester asked for.
      return { ok: true, recipientUserId: input.recipientUserId };
    case "admin_test":
      if (input.testRecipients.has(input.phoneE164)) return { ok: true };
      return (await donorConsent(input.phoneLookup, input.recipientUserId, { requireAvailability: false, allowPaused: true })).ok
        ? { ok: true }
        : { ok: false, reason: "NOT_TEST_RECIPIENT" };
    case "donor_text":
      return donorConsent(input.phoneLookup, input.recipientUserId, { requireAvailability: false, allowPaused: false });
    case "emergency_request": {
      if (!(await requestAlertable(input.requestId))) return { ok: false, reason: "REQUEST_NOT_ALERTABLE" };
      const consent = await donorConsent(input.phoneLookup, input.recipientUserId, { requireAvailability: true, allowPaused: false });
      if (!consent.ok) return consent;
      if (!(await underDailyCap(input.phoneLookup, input.stage ?? "enqueue"))) return { ok: false, reason: "FREQUENCY_CAP" };
      return consent;
    }
    case "coordinator_alert":
      return (await verifiedInstitutionContact(input.phoneLookup)) ? { ok: true } : { ok: false, reason: "NOT_VERIFIED_INSTITUTION" };
    default: {
      const unhandled: never = input.kind;
      throw new Error(`Unhandled message kind: ${String(unhandled)}`);
    }
  }
}
