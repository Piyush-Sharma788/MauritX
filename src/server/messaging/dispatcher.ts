import "server-only";
import { decryptPii } from "@/lib/security/crypto";
import { logger } from "@/lib/logger";
import { checkEligibility } from "@/server/messaging/eligibility";
import { MessagingError, type DeliveryAck, type MessagingProvider } from "@/server/messaging/provider";
import { NotificationEvent } from "@/server/models/notification-event";

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
}

export type DispatchOutcome = "idle" | "rate_limited" | "sent" | "retry" | "failed" | "suppressed";

const FINAL = { $unset: { bodyEncrypted: 1, lockedUntil: 1 } } as const;

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
 * Claims and sends at most one queued message. The caller paces calls and
 * only invokes this while the provider is connected.
 */
export async function dispatchNext(
  provider: MessagingProvider,
  options: DispatchOptions,
  now = new Date(),
): Promise<DispatchOutcome> {
  await sweep(now);

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [repliesSent, proactiveSent] = await Promise.all([
    NotificationEvent.countDocuments({ provider: provider.name, priority: 0, sentAt: { $gte: hourAgo } }),
    NotificationEvent.countDocuments({ provider: provider.name, priority: { $ne: 0 }, sentAt: { $gte: hourAgo } }),
  ]);
  const allowed = [
    ...(repliesSent < options.maxRepliesPerHour ? [0] : []),
    ...(proactiveSent < options.maxMessagesPerHour ? [1] : []),
  ];
  if (allowed.length === 0) return "rate_limited";

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
    // Distinguish "nothing to do" from "work is waiting behind a cap".
    if (allowed.length < 2 && (await NotificationEvent.exists({ status: "queued", provider: provider.name, priority: { $nin: allowed }, nextAttemptAt: { $lte: now } }))) {
      return "rate_limited";
    }
    return "idle";
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
    return "suppressed";
  }

  if (!message.bodyEncrypted) {
    await NotificationEvent.updateOne(
      { _id: message._id },
      { $set: { status: "failed", failureCode: "MISSING_BODY", failedAt: now }, ...FINAL },
    );
    return "failed";
  }

  try {
    const { providerMessageId } = await provider.sendText(phoneE164, decryptPii(message.bodyEncrypted));
    await NotificationEvent.updateOne(
      { _id: message._id, status: "sending" },
      { $set: { status: "sent", providerMessageId, sentAt: new Date() }, ...FINAL },
    );
    logger.info("messaging.sent", { messageId: message._id.toString(), kind: message.kind, attempt: message.attempts });
    return "sent";
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
      return "retry";
    }
    await NotificationEvent.updateOne(
      { _id: message._id, status: "sending" },
      { $set: { status: "failed", failureCode: code, failedAt: new Date() }, ...FINAL },
    );
    return "failed";
  }
}

/** Applies a delivery receipt. Status only ever moves forward. */
export async function recordDeliveryAck(providerMessageId: string, ack: DeliveryAck, now = new Date()): Promise<void> {
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
      { $set: { status: "failed", failureCode: "PROVIDER_ACK_ERROR", failedAt: now } },
    );
  }
}
