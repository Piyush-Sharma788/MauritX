import "server-only";
import type { Types } from "mongoose";
import type { MessageKind } from "@/features/whatsapp/types";
import { DonorProfile } from "@/server/models/donor-profile";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { User } from "@/server/models/user";

export type IneligibleReason =
  | "OPTED_OUT"
  | "NO_ACCOUNT"
  | "ACCOUNT_INACTIVE"
  | "NO_CONSENT"
  | "PAUSED"
  | "NOT_AVAILABLE"
  | "NOT_TEST_RECIPIENT";

export type Eligibility = { ok: true; recipientUserId?: Types.ObjectId } | { ok: false; reason: IneligibleReason };

interface EligibilityInput {
  kind: MessageKind;
  phoneE164: string;
  phoneLookup: string;
  recipientUserId?: Types.ObjectId;
  testRecipients: Set<string>;
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
    case "emergency_request":
      return donorConsent(input.phoneLookup, input.recipientUserId, { requireAvailability: true, allowPaused: false });
    default: {
      const unhandled: never = input.kind;
      throw new Error(`Unhandled message kind: ${String(unhandled)}`);
    }
  }
}
