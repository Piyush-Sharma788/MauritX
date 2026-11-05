import "server-only";
import type { Types } from "mongoose";
import { CONVERSATIONAL_KINDS, type MediaKey, type MessageKind, type MessageStatus } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { welcomeImageEnabled } from "@/lib/whatsapp/media-config";
import { logger } from "@/lib/logger";
import { incrementMetric } from "@/server/metrics/bot-metrics";
import { currentReplyContext } from "@/server/messaging/reply-context";
import { checkEligibility, type IneligibleReason } from "@/server/messaging/eligibility";
import type { ProviderName } from "@/server/messaging/provider";
import { getMessagingProviderName } from "@/lib/whatsapp/cloud-config";
import { emergencyAlertParams } from "@/server/messaging/cloud-templates";
import {
  emergencyRequestText,
  HELP_TEXT,
  OPT_OUT_CONFIRMATION_TEXT,
  UNSUPPORTED_MEDIA_TEXT,
  type EmergencyRequestSummary,
} from "@/server/messaging/templates";
import { NotificationEvent } from "@/server/models/notification-event";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";

/** The outbound provider new messages are queued for (MESSAGING_PROVIDER; default whatsapp_web). */
export const activeProvider = (): ProviderName => getMessagingProviderName();

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
  matchingRunId?: Types.ObjectId;
  /** Overrides WHATSAPP_WEB_MESSAGE_TTL_MINUTES for this message. */
  ttlMs?: number;
  /** Values for this kind's approved Cloud API template (used outside the 24-hour window). */
  templateParams?: string[];
  /** Send this configured image with `body` as its caption (falls back to text if the image can't go). */
  mediaKey?: MediaKey;
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
    requestId: input.requestId,
    stage: "enqueue",
  });

  const base = {
    channel: "whatsapp" as const,
    provider: activeProvider(),
    kind: input.kind,
    templateName: input.templateName,
    requestId: input.requestId,
    ...(input.matchingRunId ? { matchingRunId: input.matchingRunId } : {}),
    recipientUserId: eligibility.ok ? (eligibility.recipientUserId ?? input.recipientUserId) : input.recipientUserId,
    recipientLookup: phoneLookup,
    recipientPhoneEncrypted: encryptPii(input.phoneE164),
    idempotencyKey: input.idempotencyKey,
    requestedBy: input.requestedBy,
    priority: CONVERSATIONAL_KINDS.includes(input.kind) ? 0 : 1,
    nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? config.messageTtlMs)),
  };

  try {
    if (!eligibility.ok) {
      if (!input.recordSuppressed) return { outcome: "suppressed", messageId: null, status: "suppressed", reason: eligibility.reason };
      const doc = await NotificationEvent.create({ ...base, status: "suppressed", failureCode: eligibility.reason, failedAt: now });
      return { outcome: "suppressed", messageId: doc._id.toString(), status: "suppressed", reason: eligibility.reason };
    }
    const doc = await NotificationEvent.create({
      ...base,
      status: "queued",
      bodyEncrypted: encryptPii(input.body),
      ...(input.mediaKey ? { mediaKey: input.mediaKey } : {}),
      ...(input.templateParams?.length ? { templateParamsEncrypted: encryptPii(JSON.stringify(input.templateParams)) } : {}),
    });
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
 * One emergency alert to one consented, available donor, for a request an
 * admin verified and activated. Deduplicated per (request, donor), so retried
 * batches or repeated matching runs never re-alert. Batches are created only
 * by an admin (server/coordination/alerts.ts).
 */
export async function queueEmergencyRequestNotification(input: {
  requestId: string;
  donorUserId: Types.ObjectId;
  summary: EmergencyRequestSummary;
  matchingRunId?: Types.ObjectId;
  ttlMs?: number;
}): Promise<EnqueueResult> {
  const body = emergencyRequestText(input.summary);
  const phone = await donorPhone(input.donorUserId);
  if (!phone) return { outcome: "suppressed", messageId: null, status: "suppressed", reason: "NO_ACCOUNT" };
  return enqueueMessage({
    kind: "emergency_request",
    templateName: "emergency_alert_v2",
    phoneE164: phone,
    body,
    idempotencyKey: `emergency_request:${input.requestId}:${input.donorUserId.toString()}`,
    recipientUserId: input.donorUserId,
    requestId: input.requestId,
    matchingRunId: input.matchingRunId,
    ttlMs: input.ttlMs,
    templateParams: emergencyAlertParams(input.summary),
    recordSuppressed: true,
  });
}

/** A message to a verified institution contact about a request they coordinate. */
export async function queueCoordinatorAlert(input: { requestId: string; phoneE164: string; body: string; idempotencyKey: string }): Promise<EnqueueResult> {
  return enqueueMessage({
    kind: "coordinator_alert",
    templateName: "coordinator_alert_v1",
    phoneE164: input.phoneE164,
    body: input.body,
    idempotencyKey: `coordinator_alert:${input.idempotencyKey}`,
    requestId: input.requestId,
    recordSuppressed: true,
  });
}

/** The sign-in code text. The code is never logged; the outbox erases the body once sent. */
export const signInCodeText = (code: string, minutes: number) =>
  `${code} is your MarutiX sign-in code. It expires in ${minutes} minutes.\nDon't share it with anyone: MarutiX will never ask you for it.`;

/**
 * A sign-in code through the outbox, so the web app never has to reach the WhatsApp
 * worker directly (it may run on another machine). Expires with the code: a late code
 * is never sent. One message per OTP request.
 */
export async function queueSignInCode(input: { phoneE164: string; code: string; minutes: number; requestId: string }): Promise<EnqueueResult> {
  return enqueueMessage({
    kind: "sign_in_code",
    templateName: "sign_in_code",
    phoneE164: input.phoneE164,
    body: signInCodeText(input.code, input.minutes),
    idempotencyKey: `sign_in_code:${input.requestId}:${phoneLookupToken(input.phoneE164)}`,
    ttlMs: input.minutes * 60_000,
    recordSuppressed: false,
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

/** WhatsApp shows captions up to 1024 characters; merged replies stay under this too. */
export const MAX_MERGED_REPLY_LENGTH = 1000;

/**
 * Joins consecutive reply parts into as few messages as read well: parts are
 * kept whole and separated by a blank line, and a message never grows past
 * `maxLength`. Each WhatsApp message costs a send slot, so fewer parts arrive sooner.
 */
export function mergeReplies(parts: string[], maxLength = MAX_MERGED_REPLY_LENGTH): string[] {
  const merged: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    const last = merged.at(-1);
    if (last !== undefined && last.length + 2 + part.length <= maxLength) merged[merged.length - 1] = `${last}\n\n${part}`;
    else merged.push(part);
  }
  return merged;
}

/** Once per number, ever: the welcome image's idempotency key. */
const welcomeKey = (phoneE164: string) => `welcome_image:${phoneLookupToken(phoneE164)}`;

/**
 * Bot replies to one inbound message. The key ties each reply to the inbound
 * message, so reprocessing the same message can never send replies twice.
 * Parts are merged where they read well (mergeReplies). On a number's first
 * message the first reply carries the welcome image (see engine.ts), keyed per
 * number so it is sent at most once ever.
 */
export async function queueBotReplies(
  phoneE164: string,
  inboundMessageId: string,
  replies: string[],
  recipientUserId?: Types.ObjectId,
  templateName: "bot_reply" | "bot_menu" = "bot_reply",
) {
  const results: EnqueueResult[] = [];
  const context = currentReplyContext();
  for (const [index, body] of mergeReplies(replies).entries()) {
    const base = { kind: "bot_reply" as const, templateName, phoneE164, body, recipientUserId, recordSuppressed: false };
    if (context?.attachWelcomeImage && context.inboundMessageId === inboundMessageId) {
      context.attachWelcomeImage = false;
      if (welcomeImageEnabled() && !(await NotificationEvent.exists({ idempotencyKey: welcomeKey(phoneE164) }))) {
        const result = await enqueueMessage({ ...base, idempotencyKey: welcomeKey(phoneE164), mediaKey: "welcome" });
        if (result.outcome === "queued") {
          await incrementMetric("welcome_media_queued");
          logger.info("whatsapp.welcome_image_queued", { messageId: result.messageId });
        }
        results.push(result);
        continue;
      }
    }
    results.push(await enqueueMessage({ ...base, idempotencyKey: `bot_reply:${inboundMessageId}:${index}` }));
  }
  return results;
}

/**
 * The one-line answer to a photo, voice note, sticker or file: at most once
 * per number per day, so a burst of media doesn't become a burst of replies.
 */
export async function queueUnsupportedReply(phoneE164: string, now = new Date()): Promise<EnqueueResult> {
  return enqueueMessage(
    {
      kind: "bot_reply",
      templateName: "bot_unsupported",
      phoneE164,
      body: UNSUPPORTED_MEDIA_TEXT,
      idempotencyKey: `unsupported_reply:${phoneLookupToken(phoneE164)}:${istDay.format(now)}`,
      recordSuppressed: false,
    },
    now,
  );
}
