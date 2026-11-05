import "server-only";
import { decryptPii } from "@/lib/security/crypto";
import { logger } from "@/lib/logger";
import { resolveMediaAsset } from "@/lib/whatsapp/media-config";
import { incrementMetric } from "@/server/metrics/bot-metrics";
import { reportError } from "@/server/monitoring/report";
import { checkEligibility } from "@/server/messaging/eligibility";
import { MessagingError, type DeliveryAck, type MessagingProvider, type SendContext } from "@/server/messaging/provider";
import { NotificationEvent } from "@/server/models/notification-event";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";

export const MAX_SEND_ATTEMPTS = 3;
const SEND_LOCK_MS = 90_000;
const RETRY_DELAYS_MS = [30_000, 120_000];

export interface DispatchOptions {
  /** Cap for proactive messages (alerts, tests, confirmations). */
  maxMessagesPerHour: number;
  /** Separate cap for replies in conversations the person started. */
  maxRepliesPerHour: number;
  testRecipients: Set<string>;
  /** Admin switch: hold emergency alerts (they stay queued until they expire). */
  alertsPaused?: boolean;
  /**
   * False while the caller's pacing doesn't allow a proactive message yet (see pacing.ts);
   * conversational replies may still go. Default true.
   */
  proactiveAllowed?: boolean;
}

/** "paced": only proactive messages are waiting and the pacing interval hasn't passed. */
export type DispatchOutcome = "idle" | "rate_limited" | "paced" | "sent" | "retry" | "failed" | "suppressed";

export interface DispatchResult {
  outcome: DispatchOutcome;
  /** Whether the message handled was a reply in a conversation the person started (priority 0). */
  conversational: boolean;
}

class MessagingDeliveryFailure extends Error {
  override name = "MessagingDeliveryFailure";
}

const FINAL = { $unset: { bodyEncrypted: 1, templateParamsEncrypted: 1, lockedUntil: 1 } } as const;

/** Housekeeping that must happen before claiming work. */
async function sweep(now: Date) {
  // Stale emergency information is worse than none: never send after expiry.
  await NotificationEvent.updateMany(
    { status: "queued", expiresAt: { $lte: now } },
    { $set: { status: "failed", failureCode: "EXPIRED", failedAt: now }, ...FINAL },
  );
  // A worker died mid-send. We can't know whether WhatsApp accepted it, so
  // fail it rather than risk a duplicate message.
  await NotificationEvent.updateMany(
    { status: "sending", lockedUntil: { $lte: now } },
    { $set: { status: "failed", failureCode: "UNKNOWN_DELIVERY_STATE", failedAt: now }, ...FINAL },
  );
}

/**
 * Sends the message: an image with the body as caption when it has a usable
 * one, else text. If the image fails in a way the provider knows sent nothing
 * (file unreadable, upload refused, platform refusal), the caption goes as
 * text in the same attempt, so the person still gets the words exactly once.
 * Errors after an image send may have started are not followed by text.
 */
async function deliver(
  provider: MessagingProvider,
  message: { _id: unknown; mediaKey?: string | null },
  phoneE164: string,
  body: string,
  context: SendContext,
): Promise<{ providerMessageId: string; mediaOutcome?: "image" | "text_fallback" }> {
  if (!message.mediaKey) return provider.sendText(phoneE164, body, context);
  const asset = message.mediaKey === "welcome" ? resolveMediaAsset("welcome") : null;
  if (!asset || !provider.sendImage) {
    logger.warn("messaging.media_unavailable", { messageId: String(message._id), reason: asset ? "provider_text_only" : "asset_missing_or_disabled" });
    return { ...(await provider.sendText(phoneE164, body, context)), mediaOutcome: "text_fallback" };
  }
  try {
    return { ...(await provider.sendImage(phoneE164, asset, body, context)), mediaOutcome: "image" };
  } catch (error) {
    if (!(error instanceof MessagingError) || !error.notSent) throw error;
    logger.warn("messaging.media_fallback_text", { messageId: String(message._id), code: error.code });
    await incrementMetric("media_fallback_text", context.now);
    return { ...(await provider.sendText(phoneE164, body, context)), mediaOutcome: "text_fallback" };
  }
}

/**
 * Claims and sends at most one queued message. The caller paces calls and
 * only invokes this while the provider is connected.
 */
export async function dispatchNext(provider: MessagingProvider, options: DispatchOptions, now = new Date()): Promise<DispatchOutcome> {
  return (await dispatchOne(provider, options, now)).outcome;
}

/** dispatchNext, also saying whether the message was a conversational reply (for pacing). */
export async function dispatchOne(
  provider: MessagingProvider,
  options: DispatchOptions,
  now = new Date(),
): Promise<DispatchResult> {
  await sweep(now);
  const result = (outcome: DispatchOutcome, conversational = false): DispatchResult => ({ outcome, conversational });

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [repliesSent, proactiveSent] = await Promise.all([
    NotificationEvent.countDocuments({ provider: provider.name, priority: 0, sentAt: { $gte: hourAgo } }),
    NotificationEvent.countDocuments({ provider: provider.name, priority: { $ne: 0 }, sentAt: { $gte: hourAgo } }),
  ]);
  const replyCapOk = repliesSent < options.maxRepliesPerHour;
  const proactiveCapOk = proactiveSent < options.maxMessagesPerHour;
  const paced = options.proactiveAllowed === false;
  const allowed = [...(replyCapOk ? [0] : []), ...(proactiveCapOk && !paced ? [1] : [])];
  if (allowed.length === 0) return result(proactiveCapOk ? "paced" : "rate_limited");

  const message = await NotificationEvent.findOneAndUpdate(
    {
      status: "queued",
      provider: provider.name,
      priority: { $in: allowed },
      nextAttemptAt: { $lte: now },
      ...(options.alertsPaused ? { kind: { $ne: "emergency_request" } } : {}),
    },
    { $set: { status: "sending", lockedUntil: new Date(now.getTime() + SEND_LOCK_MS) }, $inc: { attempts: 1 } },
    // Conversational replies first, then oldest first.
    { sort: { priority: 1, nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after", lean: true },
  );
  if (!message) {
    // Distinguish "nothing to do" from "work is waiting behind a cap or the pacing interval".
    if (allowed.length < 2 && (await NotificationEvent.exists({ status: "queued", provider: provider.name, priority: { $nin: allowed }, nextAttemptAt: { $lte: now } }))) {
      return result(!allowed.includes(1) && proactiveCapOk && paced ? "paced" : "rate_limited");
    }
    return result("idle");
  }
  const conversational = message.priority === 0;

  if (!message.recipientPhoneEncrypted) {
    await NotificationEvent.updateOne({ _id: message._id }, { $set: { status: "suppressed", failureCode: "ACCOUNT_DELETED", failedAt: now }, ...FINAL });
    return result("suppressed", conversational);
  }
  const phoneE164 = decryptPii(message.recipientPhoneEncrypted);

  // Consent can be withdrawn between queueing and sending.
  const eligibility = await checkEligibility({
    kind: message.kind,
    phoneE164,
    phoneLookup: message.recipientLookup,
    recipientUserId: message.recipientUserId ?? undefined,
    testRecipients: options.testRecipients,
    requestId: message.requestId,
    stage: "dispatch",
  });
  if (!eligibility.ok) {
    await NotificationEvent.updateOne(
      { _id: message._id },
      { $set: { status: "suppressed", failureCode: eligibility.reason, failedAt: now }, ...FINAL },
    );
    return result("suppressed", conversational);
  }

  if (!message.bodyEncrypted) {
    await NotificationEvent.updateOne(
      { _id: message._id },
      { $set: { status: "failed", failureCode: "MISSING_BODY", failedAt: now }, ...FINAL },
    );
    return result("failed", conversational);
  }

  try {
    // The person's last message to us opens a 24-hour window for free-form replies (Cloud API rule).
    const lastInbound = await WhatsAppInboundMessage.findOne({ phoneLookup: message.recipientLookup }, { receivedAt: 1 }).sort({ receivedAt: -1 }).lean();
    const { providerMessageId, mediaOutcome } = await deliver(provider, message, phoneE164, decryptPii(message.bodyEncrypted), {
      kind: message.kind,
      templateParams: message.templateParamsEncrypted ? (JSON.parse(decryptPii(message.templateParamsEncrypted)) as string[]) : null,
      lastInboundAt: lastInbound?.receivedAt ?? null,
      now,
    });
    await NotificationEvent.updateOne(
      { _id: message._id, status: "sending" },
      { $set: { status: "sent", providerMessageId, sentAt: new Date(), ...(mediaOutcome ? { mediaOutcome } : {}) }, ...FINAL },
    );
    logger.info("messaging.sent", { messageId: message._id.toString(), kind: message.kind, attempt: message.attempts, ...(mediaOutcome ? { media: mediaOutcome } : {}) });
    return result("sent", conversational);
  } catch (error) {
    const code = error instanceof MessagingError ? error.code : "SEND_FAILED";
    const retryable = error instanceof MessagingError ? error.retryable : true;
    const canRetry = retryable && message.attempts < MAX_SEND_ATTEMPTS;
    logger.warn("messaging.send_failed", {
      messageId: message._id.toString(),
      kind: message.kind,
      attempt: message.attempts,
      code,
      willRetry: canRetry,
    });
    if (canRetry) {
      const delay = RETRY_DELAYS_MS[Math.min(message.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      await NotificationEvent.updateOne(
        { _id: message._id, status: "sending" },
        { $set: { status: "queued", failureCode: code, nextAttemptAt: new Date(now.getTime() + delay) }, $unset: { lockedUntil: 1 } },
      );
      return result("retry", conversational);
    }
    await NotificationEvent.updateOne(
      { _id: message._id, status: "sending" },
      { $set: { status: "failed", failureCode: code, failedAt: new Date() }, ...FINAL },
    );
    // Final failures only: grouped by provider error code (an unexpected exception groups by its message).
    await reportError(error instanceof MessagingError ? new MessagingDeliveryFailure(code) : error, { source: "messaging", event: "messaging.delivery_failed", where: `${provider.name}:${message.kind}` });
    return result("failed", conversational);
  }
}

/** Applies a delivery receipt. Status only ever moves forward. */
export async function recordDeliveryAck(providerMessageId: string, ack: DeliveryAck, now = new Date(), failureCode = "PROVIDER_ACK_ERROR"): Promise<void> {
  if (ack === "server") return; // Already "sent".
  if (ack === "device") {
    await NotificationEvent.updateOne({ providerMessageId, status: "sent" }, { $set: { status: "delivered", deliveredAt: now } });
  } else if (ack === "read") {
    await NotificationEvent.updateOne(
      { providerMessageId, status: { $in: ["sent", "delivered"] } },
      { $set: { status: "read", readAt: now } },
    );
  } else {
    await NotificationEvent.updateOne(
      { providerMessageId, status: "sent" },
      { $set: { status: "failed", failureCode, failedAt: now } },
    );
  }
}
