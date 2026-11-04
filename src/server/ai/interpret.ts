import "server-only";
import { getAiConfig } from "@/lib/ai/config";
import { AppError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { AnthropicAiProvider } from "@/server/ai/anthropic";
import type { AiMessageContext, AiProvider } from "@/server/ai/provider";
import { interpretationSchema, type AiIntent, type Interpretation } from "@/server/ai/schema";
import { incrementMetric } from "@/server/metrics/bot-metrics";
import { enforceRateLimit } from "@/server/services/rate-limit";

/**
 * Turns free text into a validated, proposed intent. AI is optional: with it
 * off, failing, rate-limited or returning anything malformed, the
 * deterministic keyword classifier below answers instead. Nothing here acts
 * on the result; the bot does, after its own checks.
 */

let override: AiProvider | null | undefined;

/** Test hook: use a fake provider (or null for none). */
export function setAiProviderForTests(provider: AiProvider | null | undefined) {
  override = provider;
}

let configured: AiProvider | null | undefined;

function activeProvider(): AiProvider | null {
  if (override !== undefined) return override;
  if (configured === undefined) {
    const config = getAiConfig();
    configured = config.provider === "anthropic" ? new AnthropicAiProvider(config) : null;
  }
  return configured;
}

/** Phone numbers never leave MarutiX for the AI provider. */
export function redactForAi(text: string): string {
  return text
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export type InterpretationSource = "ai" | "keywords";

export async function interpretMessage(
  text: string,
  context: AiMessageContext,
  phoneLookup: string,
  now = new Date(),
): Promise<{ interpretation: Interpretation; source: InterpretationSource }> {
  const fallback = { interpretation: classifyByKeywords(text), source: "keywords" as const };
  const provider = activeProvider();
  if (!provider) return fallback;

  try {
    await enforceRateLimit({ scope: "ai:phone", limit: getAiConfig().maxCallsPerNumberPerHour, windowSeconds: 60 * 60 }, phoneLookup, now);
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") return fallback;
    throw error;
  }

  await incrementMetric("ai_calls", now);
  let raw: unknown;
  try {
    raw = await provider.interpret(redactForAi(text), context);
  } catch (error) {
    await incrementMetric("ai_errors", now);
    logger.warn("ai.interpret_failed", { provider: provider.name, errorName: error instanceof Error ? error.name : "UnknownError" });
    return fallback;
  }
  const parsed = interpretationSchema.safeParse(raw);
  if (!parsed.success) {
    await incrementMetric("ai_rejected_output", now);
    logger.warn("ai.output_rejected", { provider: provider.name, issue: parsed.error.issues[0]?.path.join(".") });
    return fallback;
  }
  return { interpretation: parsed.data, source: "ai" };
}

/* ------------------------------------------------------------------------ */
/* Deterministic fallback                                                   */
/* ------------------------------------------------------------------------ */

const RULES: [AiIntent, RegExp][] = [
  ["stop_messages", /\b(stop (sending|messaging|messages|alerts)|unsubscribe|don'?t (message|text|send)|band karo)\b/i],
  ["cancel_request", /\b(cancel (my|the|this)?\s*request|no longer need(ed)? blood|blood (is )?not needed)\b/i],
  ["track_request", /\b(track|status of (my|the) request|update on (my|the) request|any donors?)\b/i],
  ["register_donor", /\b(register|sign ?up|become a donor|be a donor|want to donate|i want to give blood|donor banna)\b/i],
  ["create_request", /\b(need|needs|needed|require[sd]?|urgent(ly)?|chahiye|zaroorat)\b.*\b(blood|platelets?|plasma|prbc|units?|khoon)\b|\b(blood|platelets?|plasma|khoon)\b.*\b(need|needed|required|urgent(ly)?|chahiye|zaroorat)\b/i],
  ["donor_interested", /\b(i can help|i can donate|i am available|i'?m available|count me in)\b/i],
  ["pause_alerts", /\b(pause|hold) (my )?alerts\b/i],
  ["help", /\b(help|menu|options|what can you do)\b/i],
  ["greeting", /^(hi|hello|hey|namaste|namaskar|good (morning|afternoon|evening))\b/i],
];

const BLOOD_GROUP_TEXT = /\b(AB|A|B|O)\s*(\+|-|−|\+ve|-ve|pos(?:itive)?|neg(?:ative)?)(?=\s|$|[.,!])/i;
const COMPONENT_TEXT = /\b(whole blood|prbc|packed red cells?|red cells?|platelets?|sdp|plasma|ffp)\b/i;
const UNITS_TEXT = /\b(\d{1,2})\s*(units?|bags?|bottles?)\b/i;
const IN_CITY_TEXT = /\b(?:in|at)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*(?:[.,!]|$)/;
const TIME_TEXT = /\b(now|asap|immediately|urgent(?:ly)?|today(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?|tonight|tomorrow(?:\s+(?:morning|evening|\d{1,2}(?::\d{2})?\s*(?:am|pm)))?|in\s+\d{1,2}\s*(?:hours?|hrs?))\b/i;

/** Keyword intent plus the obvious entities, for when AI is off or unavailable. */
export function classifyByKeywords(text: string): Interpretation {
  const intent = RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
  const group = BLOOD_GROUP_TEXT.exec(text);
  const time = TIME_TEXT.exec(text)?.[1] ?? null;
  return {
    intent,
    entities: {
      bloodGroup: group ? group[0].trim() : null,
      component: COMPONENT_TEXT.exec(text)?.[1] ?? null,
      units: UNITS_TEXT.exec(text) ? Math.min(20, Math.max(1, Number(UNITS_TEXT.exec(text)![1]))) : null,
      city: intent === "create_request" ? (IN_CITY_TEXT.exec(text)?.[1] ?? null) : null,
      locality: null,
      hospitalName: null,
      requiredBy: time && /^urgent/i.test(time) ? "now" : time,
      requestId: /\bMX-?[0-9A-HJKMNP-TV-Z]{8}\b/i.exec(text)?.[0] ?? null,
    },
    confidence: intent === "other" ? 0 : 0.6,
    missing_fields: [],
    requires_confirmation: intent !== "other" && intent !== "help" && intent !== "greeting",
    suggested_response: "",
  };
}

/** Words that would claim an outcome the backend hasn't produced. */
const UNSAFE_REPLY = /(registered|confirmed|cancel+ed|verified|eligible|compatible|submitted|saved|sent|booked|guarantee|https?:|www\.|\d{6,})/i;

/** An AI-written clarifying reply, only if it's short and claims nothing. */
export function safeSuggestedReply(interpretation: Interpretation): string | null {
  const text = interpretation.suggested_response.trim();
  if (!text || text.length > 300 || UNSAFE_REPLY.test(text)) return null;
  return text;
}
