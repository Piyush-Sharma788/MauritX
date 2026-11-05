import "server-only";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { phoneLookupToken } from "@/lib/security/crypto";
import type { InboundMessage } from "@/server/conversations/bot";
import { processConversation } from "@/server/conversations/engine";
import { incrementMetric } from "@/server/metrics/bot-metrics";
import { getMessagingSettings } from "@/server/settings/service";
import { recordOptOut } from "@/server/messaging/opt-out";
import { queueSystemReply } from "@/server/messaging/queue";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";
import { enforceRateLimit } from "@/server/services/rate-limit";

export type { InboundMessage };

const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "STOP ALERTS", "STOPALL", "STOP ALL"]);
const PROCESSED_ID_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const INBOUND_LIMIT = { scope: "wa-inbound:phone", limit: 40, windowSeconds: 60 * 60 };

export type InboundOutcome = "duplicate" | "rate_limited" | "opt_out" | "bot_disabled" | "handled";

const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;

/** Serialises messages per number inside the (single) worker, so a fast double-reply can't race. */
const chains = new Map<string, Promise<unknown>>();
function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/**
 * Entry point for every inbound WhatsApp message. Content is untrusted:
 * - each provider message ID is processed at most once;
 * - each number is rate-limited;
 * - STOP always wins and takes effect immediately;
 * - with the bot switched on, everything else goes to the conversation engine.
 */
export async function handleInboundMessage(msg: InboundMessage, now = new Date()): Promise<InboundOutcome> {
  await connectToDatabase();
  const phoneLookup = phoneLookupToken(msg.fromE164);
  try {
    await WhatsAppInboundMessage.create({
      providerMessageId: msg.providerMessageId,
      phoneLookup,
      receivedAt: now,
      expiresAt: new Date(now.getTime() + PROCESSED_ID_RETENTION_MS),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return "duplicate";
    throw error;
  }

  try {
    await enforceRateLimit(INBOUND_LIMIT, phoneLookup, now);
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      logger.warn("whatsapp.inbound_rate_limited");
      return "rate_limited";
    }
    throw error;
  }

  return serialised(phoneLookup, async () => {
    const keyword = msg.input.type === "text" ? msg.input.text.trim().toUpperCase().replace(/\s+/g, " ") : "";
    if (STOP_WORDS.has(keyword)) {
      await recordOptOut(msg.fromE164, "whatsapp_stop", now);
      await queueSystemReply("opt_out_confirmation", msg.fromE164, now);
      return "opt_out" as const;
    }
    // Admins can switch the bot off; STOP above is honoured regardless.
    if (!(await getMessagingSettings()).botEnabled) {
      await incrementMetric("inbound_dropped_disabled", now);
      return "bot_disabled" as const;
    }
    try {
      await processConversation(msg, now);
    } catch (error) {
      await incrementMetric("bot_errors", now);
      throw error;
    }
    await incrementMetric("inbound_processed", now);
    return "handled" as const;
  });
}
