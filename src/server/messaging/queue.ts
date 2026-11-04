import "server-only";
import type { Types } from "mongoose";
import { CONVERSATIONAL_KINDS, type MessageKind, type MessageStatus } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { checkEligibility, type IneligibleReason } from "@/server/messaging/eligibility";
import type { ProviderName } from "@/server/messaging/provider";
import {
  emergencyRequestText,
  HELP_TEXT,
  OPT_OUT_CONFIRMATION_TEXT,
  type EmergencyRequestSummary,
} from "@/server/messaging/templates";
import { NotificationEvent } from "@/server/models/notification-event";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";

/** The active outbound provider. Switch to "whatsapp_cloud" when migrating. */
export const ACTIVE_PROVIDER: ProviderName = "whatsapp_web";

export type EnqueueResult =
  | { outcome: "queued" | "duplicate"; messageId: string; status: MessageStatus }
  | { outcome: "suppressed"; messageId: string | null; status: "suppressed"; reason: IneligibleReason };

export interface EnqueueInput {
  kind: MessageKind;
  templateName: string;
  phoneE164: string;
  body: string;
  idempotencyKey: string;
  recipientUserId?: Types.ObjectId;
  requestedBy?: Types.ObjectId;
  requestId?: string;
  /** Record a `suppressed` event when ineligible (donor-facing kinds), instead of nothing. */
  recordSuppressed: boolean;
}

const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;

async function existing(idempotencyKey: string): Promise<EnqueueResult | null> {
  const doc = await NotificationEvent.findOne({ idempotencyKey }, { status: 1 }).lean();
  return doc ? { outcome: "duplicate", messageId: doc._id.toString(), status: doc.status } : null;
}

/**
 * Adds a message to the outbox. Consent and opt-out are checked here and again
 * by the dispatcher just before sending. The unique idempotency key means the
 * same notification can never be queued twice.
 */
export async function enqueueMessage(input: EnqueueInput, now = new Date()): Promise<EnqueueResult> {
  await connectToDatabase();
  const config = getWhatsAppWebConfig();
  const duplicate = await existing(input.idempotencyKey);
  if (duplicate) return duplicate;

  const phoneLookup = phoneLookupToken(input.phoneE164);
  const eligibility = await checkEligibility({
    kind: input.kind,
    phoneE164: input.phoneE164,
    phoneLookup,
    recipientUserId: input.recipientUserId,
    testRecipients: config.testRecipients,
  });

  const base = {
    channel: "whatsapp" as const,
    provider: ACTIVE_PROVIDER,
    kind: input.kind,
    templateName: input.templateName,
    requestId: input.requestId,
    recipientUserId: eligibility.ok ? (eligibility.recipientUserId ?? input.recipientUserId) : input.recipientUserId,
    recipientLookup: phoneLookup,
    recipientPhoneEncrypted: encryptPii(input.phoneE164),
    idempotencyKey: input.idempotencyKey,
    requestedBy: input.requestedBy,
    priority: CONVERSATIONAL_KINDS.includes(input.kind) ? 0 : 1,
    nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + config.messageTtlMs),
  };

  try {
    if (!eligibility.ok) {
      if (!input.recordSuppressed) return { outcome: "suppressed", messageId: null, status: "suppressed", reason: eligibility.reason };
      const doc = await NotificationEvent.create({ ...base, status: "suppressed", failureCode: eligibility.reason, failedAt: now });
      return { outcome: "suppressed", messageId: doc._id.toString(), status: "suppressed", reason: eligibility.reason };
    }
    const doc = await NotificationEvent.create({ ...base, status: "queued", bodyEncrypted: encryptPii(input.body) });
    return { outcome: "queued", messageId: doc._id.toString(), status: "queued" };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    return (await existing(input.idempotencyKey))!;
  }
}

async function donorPhone(donorUserId: Types.ObjectId): Promise<string | null> {
  await connectToDatabase();
  const user = await User.findById(donorUserId, { phoneEncrypted: 1 }).lean();
  return user ? decryptPii(user.phoneEncrypted) : null;
}

/* ------------------------------------------------------------------------ */

/**
 * Admin test message. Allowed only to WHATSAPP_WEB_TEST_RECIPIENTS or to a
 * donor with recorded WhatsApp consent, and never to an opted-out number.
 */
export async function queueAdminTestMessage(input: {
  phoneE164: string;
  text: string;
  adminUserId: Types.ObjectId;
  idempotencyKey: string;
  requestId: string;
}): Promise<{ messageId: string; status: MessageStatus; duplicate: boolean }> {
  const result = await enqueueMessage({
    kind: "admin_test",
    templateName: "admin_test_text",
    phoneE164: input.phoneE164,
    body: input.text,
    idempotencyKey: `admin_test:${input.adminUserId.toString()}:${input.idempotencyKey}`,
    requestedBy: input.adminUserId,
    recordSuppressed: false,
  });

  if (result.outcome === "suppressed") {
    throw result.reason === "OPTED_OUT"
      ? new AppError(403, "RECIPIENT_OPTED_OUT", "This number has opted out of MarutiX messages.")
      : new AppError(
          403,
          "RECIPIENT_NOT_ALLOWED",
          "Test messages can only be sent to numbers in WHATSAPP_WEB_TEST_RECIPIENTS or donors who have consented to WhatsApp alerts.",
        );
  }
  if (result.outcome === "queued") {
    await recordAudit({
      action: "whatsapp.message_queued",
      outcome: "success",
      requestId: input.requestId,
      actorUserId: input.adminUserId,
      resourceType: "notification_event",
      resourceId: result.messageId,
    });
  }
  return { messageId: result.messageId, status: result.status, duplicate: result.outcome === "duplicate" };
}

/** Plain text to a consented donor. Not exposed through any endpoint yet. */
export async function queueDonorTextMessage(input: {
  donorUserId: Types.ObjectId;
  text: string;
  idempotencyKey: string;
  requestedBy?: Types.ObjectId;
}): Promise<EnqueueResult> {
  const phone = await donorPhone(input.donorUserId);
  if (!phone) return { outcome: "suppressed", messageId: null, status: "suppressed", reason: "NO_ACCOUNT" };
  return enqueueMessage({
    kind: "donor_text",
    templateName: "donor_text",
    phoneE164: phone,
    body: input.text,
    idempotencyKey: `donor_text:${input.donorUserId.toString()}:${input.idempotencyKey}`,
    recipientUserId: input.donorUserId,
    requestedBy: input.requestedBy,
    recordSuppressed: true,
  });
}

/**
 * One emergency alert to one consented, available donor. Deduplicated per
 * (request, donor), so retries or repeated matching runs never re-alert.
 * Broadcast/wave orchestration is a later phase and is deliberately absent.
 */
export async function queueEmergencyRequestNotification(input: {
  requestId: string;
  donorUserId: Types.ObjectId;
  summary: EmergencyRequestSummary;
}): Promise<EnqueueResult> {
  const body = emergencyRequestText(input.summary);
  const phone = await donorPhone(input.donorUserId);
  if (!phone) return { outcome: "suppressed", messageId: null, status: "suppressed", reason: "NO_ACCOUNT" };
  return enqueueMessage({
    kind: "emergency_request",
    templateName: "donor_request_v1",
    phoneE164: phone,
    body,
    idempotencyKey: `emergency_request:${input.requestId}:${input.donorUserId.toString()}`,
    recipientUserId: input.donorUserId,
    requestId: input.requestId,
    recordSuppressed: true,
  });
}

const istDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

/** STOP confirmation or HELP reply; at most one of each per number per day. */
export async function queueSystemReply(
  kind: "opt_out_confirmation" | "help_reply",
  phoneE164: string,
  now = new Date(),
): Promise<EnqueueResult> {
  return enqueueMessage(
    {
      kind,
      templateName: kind,
      phoneE164,
      body: kind === "opt_out_confirmation" ? OPT_OUT_CONFIRMATION_TEXT : HELP_TEXT,
      idempotencyKey: `${kind}:${phoneLookupToken(phoneE164)}:${istDay.format(now)}`,
      recordSuppressed: true,
    },
    now,
  );
}

/**
 * Bot replies to one inbound message. The key ties each reply to the inbound
 * message, so reprocessing the same message can never send replies twice.
 */
export async function queueBotReplies(
  phoneE164: string,
  inboundMessageId: string,
  replies: string[],
  recipientUserId?: Types.ObjectId,
  templateName: "bot_reply" | "bot_menu" = "bot_reply",
) {
  const results: EnqueueResult[] = [];
  for (const [index, body] of replies.entries()) {
    results.push(
      await enqueueMessage({
        kind: "bot_reply",
        templateName,
        phoneE164,
        body,
        idempotencyKey: `bot_reply:${inboundMessageId}:${index}`,
        recipientUserId,
        recordSuppressed: false,
      }),
    );
  }
  return results;
}
