import "server-only";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { phoneLookupToken } from "@/lib/security/crypto";
import type { InboundMessage } from "@/server/conversations/bot";
import { processConversation } from "@/server/conversations/engine";
import { incrementMetric } from "@/server/metrics/bot-metrics";
import { getMessagingSettings } from "@/server/settings/service";
import { isOptedOut, verifiedInstitutionContact } from "@/server/messaging/eligibility";
import { recordOptOut } from "@/server/messaging/opt-out";
import { queueSystemReply, queueUnsupportedReply } from "@/server/messaging/queue";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";
import { enforceRateLimit } from "@/server/services/rate-limit";

export type { InboundMessage };

/** A photo, voice note, sticker, file or contact card: something the bot can't read. */
export interface UnsupportedInbound {
  providerMessageId: string;
  fromE164: string;
  input: { type: "unsupported"; mediaType: string };
}

/** Everything a provider may hand to the pipeline. */
export type InboundEvent = InboundMessage | UnsupportedInbound;

/** Inbound text is cut at this length by the providers; nothing the bot asks for needs more. */
export const MAX_INBOUND_TEXT = 1000;

const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "STOP ALERTS", "STOPALL", "STOP ALL"]);
const PROCESSED_ID_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const INBOUND_LIMIT = { scope: "wa-inbound:phone", limit: 40, windowSeconds: 60 * 60 };

export type InboundOutcome = "duplicate" | "rate_limited" | "opt_out" | "bot_disabled" | "empty" | "unsupported" | "handled";

/** Logged for every inbound message that gets no processing, without the number or content. */
const dropped = (reason: string, extra: Record<string, string> = {}) => logger.info("whatsapp.inbound_dropped", { reason, ...extra });

/**
 * A number's first-ever contact: no earlier inbound message, conversation or
 * account, and not a verified institution contact. (Inbound IDs are kept 14
 * days and idle conversations 30, so "ever" is backed by the welcome image's
 * own once-per-number key in the outbox.)
 */
async function isFirstContact(phoneLookup: string, providerMessageId: string): Promise<boolean> {
  const [earlier, conversation, user] = await Promise.all([
    WhatsAppInboundMessage.exists({ phoneLookup, providerMessageId: { $ne: providerMessageId } }),
    WhatsAppConversation.exists({ phoneLookup }),
    User.exists({ phoneLookup }),
  ]);
  if (earlier || conversation || user) return false;
  return !(await verifiedInstitutionContact(phoneLookup));
}

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
export async function handleInboundMessage(msg: InboundEvent, now = new Date()): Promise<InboundOutcome> {
  await connectToDatabase();
  const phoneLookup = phoneLookupToken(msg.fromE164);
  // The whole pipeline runs in arrival order per number, so two quick messages can't swap places.
  return serialised(phoneLookup, () => processInbound(msg, phoneLookup, now));
}

async function processInbound(msg: InboundEvent, phoneLookup: string, now: Date): Promise<InboundOutcome> {
  try {
    await WhatsAppInboundMessage.create({
      providerMessageId: msg.providerMessageId,
      phoneLookup,
      receivedAt: now,
      expiresAt: new Date(now.getTime() + PROCESSED_ID_RETENTION_MS),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      dropped("duplicate_message_id");
      return "duplicate";
    }
    throw error;
  }

  try {
    await enforceRateLimit(INBOUND_LIMIT, phoneLookup, now);
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      logger.warn("whatsapp.inbound_rate_limited");
      dropped("rate_limited");
      return "rate_limited";
    }
    throw error;
  }

  if (msg.input.type === "unsupported") return handleUnsupported(msg as UnsupportedInbound, phoneLookup, now);
  const message = msg as InboundMessage;
  if (message.input.type === "text" && !message.input.text.trim()) {
    dropped("empty_text");
    await incrementMetric("inbound_dropped_empty", now);
    return "empty" as const;
  }
  const keyword = message.input.type === "text" ? message.input.text.trim().toUpperCase().replace(/\s+/g, " ") : "";
  if (STOP_WORDS.has(keyword)) {
    await recordOptOut(message.fromE164, "whatsapp_stop", now);
    await queueSystemReply("opt_out_confirmation", message.fromE164, now);
    return "opt_out" as const;
  }
  // Admins can switch the bot off; STOP above is honoured regardless.
  if (!(await getMessagingSettings()).botEnabled) {
    dropped("bot_disabled");
    await incrementMetric("inbound_dropped_disabled", now);
    return "bot_disabled" as const;
  }
  try {
    await processConversation(message, now, { firstContact: await isFirstContact(phoneLookup, message.providerMessageId) });
  } catch (error) {
    await incrementMetric("bot_errors", now);
    throw error;
  }
  await incrementMetric("inbound_processed", now);
  return "handled" as const;
}

/** Photos, voice notes and the like: one polite line a day, never after STOP or with the bot off. */
async function handleUnsupported(msg: UnsupportedInbound, phoneLookup: string, now: Date): Promise<InboundOutcome> {
  await incrementMetric("inbound_unsupported", now);
  if (await isOptedOut(phoneLookup)) {
    dropped("unsupported_type_opted_out", { type: msg.input.mediaType.slice(0, 30) });
    return "unsupported";
  }
  if (!(await getMessagingSettings()).botEnabled) {
    dropped("bot_disabled", { type: msg.input.mediaType.slice(0, 30) });
    return "bot_disabled";
  }
  const result = await queueUnsupportedReply(msg.fromE164, now);
  logger.info("whatsapp.inbound_unsupported", { type: msg.input.mediaType.slice(0, 30), replied: result.outcome === "queued" });
  return "unsupported";
}
