import "server-only";
import { getAiConfig } from "@/lib/ai/config";
import { AppError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { AnthropicAiProvider } from "@/server/ai/anthropic";
import { JsonLlmAiProvider } from "@/server/ai/json-provider";
import { AiProviderError, type AiMessageContext, type AiProvider } from "@/server/ai/provider";
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
    configured =
      config.provider === "anthropic" ? new AnthropicAiProvider(config)
      : config.provider === "gemini" || config.provider === "openai" ? new JsonLlmAiProvider(config)
      : null;
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
    logger.warn("ai.interpret_failed", {
      provider: provider.name,
      errorName: error instanceof Error ? error.name : "UnknownError",
      code: error instanceof AiProviderError ? error.code : null,
      status: error instanceof AiProviderError ? error.status : null,
    });
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

/**
 * Common misspellings and spelling variants (English and romanised Hindi) →
 * one canonical word, applied before the rules below. Repeated letters are
 * collapsed first ("bloooood" → "blood"), and longer words within one typo
 * (two for long words) of a canonical word are corrected too.
 */
const VARIANTS: Record<string, string> = {
  blod: "blood", bld: "blood", bloodd: "blood", blud: "blood", blooad: "blood",
  khun: "khoon", khoon: "khoon", khon: "khoon", rakt: "khoon", rakht: "khoon",
  chaiye: "chahiye", chahie: "chahiye", chahiya: "chahiye", chahye: "chahiye", chahiyee: "chahiye", chaahiye: "chahiye", chaahie: "chahiye", chiye: "chahiye", chahiyae: "chahiye", chahia: "chahiye",
  zarurat: "zaroorat", jarurat: "zaroorat", jaroorat: "zaroorat", zarorat: "zaroorat", zarurt: "zaroorat", jrurat: "zaroorat", zrurat: "zaroorat", zaruri: "zaroorat", jaruri: "zaroorat", zaroori: "zaroorat", jaroori: "zaroorat",
  pahucha: "pahuncha", pahuchi: "pahuncha", pahunchi: "pahuncha", pohncha: "pahuncha", pohcha: "pahuncha", pahuch: "pahuncha", pahunch: "pahuncha", pauncha: "pahuncha",
  kahan: "kaha", kha: "kaha", kidhar: "kaha",
  trak: "track", trck: "track", trac: "track",
  donr: "donor", donar: "donor", doner: "donor", dnor: "donor", daata: "donor",
  regster: "register", registr: "register", regiter: "register", rejister: "register", registar: "register", ragister: "register",
  reqest: "request", requst: "request", reques: "request", rqst: "request", req: "request",
  urjent: "urgent", urgnt: "urgent", argent: "urgent", urgant: "urgent",
  emergancy: "emergency", emergeny: "emergency", emrgency: "emergency", emergncy: "emergency", imergency: "emergency",
  platlets: "platelets", plateletes: "platelets", platelate: "platelets", platlet: "platelets",
  plz: "please", pls: "please",
  bandh: "band", bnd: "band",
  madat: "madad",
  hii: "hi", hlo: "hello", helo: "hello", hello: "hello", namastey: "namaste", namskar: "namaskar",
  nahin: "nahi", nhi: "nahi", nai: "nahi",
  muje: "mujhe", mjhe: "mujhe",
};
const CANONICAL = [
  "blood", "donor", "donate", "donation", "register", "request", "track", "cancel", "urgent", "urgently", "emergency", "platelets",
  "plasma", "needed", "required", "status", "update", "profile", "unsubscribe", "hospital", "chahiye", "zaroorat", "pahuncha",
  "available", "interested", "information", "resume", "alerts", "messages", "patient", "transfusion",
];
const CANONICAL_SET = new Set(CANONICAL);
/** Real words one typo away from a canonical word, which must not be "corrected". */
const KEEP = new Set(["cancer", "truck", "trick", "plates", "statue", "state", "states", "stats", "blond", "bloom", "donna", "alter", "patent", "update", "dated", "planets"]);

/** Damerau-Levenshtein distance (adjacent swaps count as one typo), capped for speed. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function canonicalWord(word: string): string {
  const collapsed = word.replace(/(.)\1{2,}/g, "$1$1");
  if (CANONICAL_SET.has(collapsed) || KEEP.has(collapsed)) return collapsed;
  const variant = VARIANTS[collapsed] ?? VARIANTS[collapsed.replace(/(.)\1/g, "$1")];
  if (variant) return variant;
  if (collapsed.length < 5) return collapsed;
  const max = collapsed.length >= 8 ? 2 : 1;
  let best: string | null = null;
  let bestDistance = max + 1;
  for (const candidate of CANONICAL) {
    const distance = editDistance(collapsed, candidate, max);
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best ?? collapsed;
}

/**
 * Common Hindi words written in Devanagari → the Hinglish spellings the rules already know,
 * so "मुझे खून चाहिए" works like "mujhe khoon chahiye". Longer phrases first.
 * (Without this, Devanagari vowel signs would be stripped below and nothing would match.)
 */
const DEVANAGARI_WORDS: [string, string][] = [
  ["के लिए", "ke liye"], ["कहाँ तक", "kaha tak"], ["कहां तक", "kaha tak"], ["क्या हुआ", "kya hua"],
  ["रक्तदान", "raktdaan"], ["खूनदान", "khoondaan"], ["ब्लड", "blood"], ["खून", "khoon"], ["रक्त", "rakt"],
  ["चाहिए", "chahiye"], ["चाहिये", "chahiye"], ["ज़रूरत", "zaroorat"], ["जरूरत", "zaroorat"], ["आवश्यकता", "zaroorat"],
  ["डोनर", "donor"], ["बनना", "banna"], ["बनाना", "banana"], ["दान", "daan"], ["देना", "dena"],
  ["मरीज़", "mareez"], ["मरीज", "mareez"], ["पेशेंट", "patient"], ["को", "ko"], ["की", "ki"], ["का", "ka"],
  ["मेरा", "mera"], ["मेरी", "meri"], ["मुझे", "mujhe"], ["रिक्वेस्ट", "request"], ["अनुरोध", "request"],
  ["स्टेटस", "status"], ["कहाँ", "kaha"], ["कहां", "kaha"], ["तक", "tak"], ["अपडेट", "update"],
  ["बंद", "band"], ["करो", "karo"], ["कर", "kar"], ["दो", "do"], ["मत", "mat"], ["भेजो", "bhejo"], ["मैसेज", "message"],
  ["रद्द", "radd"], ["कैंसिल", "cancel"], ["नहीं", "nahi"], ["नही", "nahi"], ["हाँ", "haan"], ["हां", "haan"],
  ["मदद", "madad"], ["सहायता", "sahayata"], ["नमस्ते", "namaste"], ["नमस्कार", "namaskar"], ["प्रणाम", "pranam"],
  ["अभी", "abhi"], ["तुरंत", "turant"], ["जल्दी", "jaldi"], ["में", "mein"], ["यूनिट", "unit"],
  ["एक", "ek"], ["तीन", "teen"], ["चार", "char"], ["पांच", "paanch"], ["पाँच", "paanch"],
];
const NOT_DEVANAGARI_BEFORE = "(?<![\\u0900-\\u097F])";
const NOT_DEVANAGARI_AFTER = "(?![\\u0900-\\u097F])";
const DEVANAGARI_PATTERNS = DEVANAGARI_WORDS.map(([hi, latin]) => [new RegExp(`${NOT_DEVANAGARI_BEFORE}${hi}${NOT_DEVANAGARI_AFTER}`, "g"), latin] as const);

export function transliterateHindi(text: string): string {
  if (!/[\u0900-\u097F]/.test(text)) return text;
  let out = text;
  for (const [pattern, latin] of DEVANAGARI_PATTERNS) out = out.replace(pattern, latin);
  return out;
}

/** Lower-case, typo-corrected text for the keyword rules (entities are read from the original). */
export function normaliseForIntent(text: string): string {
  return transliterateHindi(text)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'+\-\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]+$/.test(w) ? canonicalWord(w) : w))
    .join(" ");
}

const GROUP = String.raw`(?:ab|a|b|o)\s*(?:\+|-|−|\+ve|-ve|pos(?:itive)?|neg(?:ative)?)`;
const NEED = String.raw`(?:need|needs|needed|require|required|requires|urgent|urgently|emergency|chahiye|zaroorat|want|wanted|looking for|arrange|arrangement)`;
const BLOOD = String.raw`(?:blood|khoon|platelets?|plasma|prbc|sdp|ffp|units?|donors?)`;

/**
 * Ordered: the first match wins, so the more specific intents come first
 * ("ab blood nahi chahiye" is a cancellation, not a request; "donor banna hai"
 * is a registration, "donor chahiye" a request).
 */
const RULES: [AiIntent, RegExp][] = [
  ["pause_alerts", /\b((pause|hold) (my |the )?alerts?|alerts? (band|rok|pause)( kar\w*)?|kuch din (alerts?|messages?) (mat|na) bhej\w*)\b/],
  ["stop_messages", /\b(stop (sending|messaging|messages|texting|contacting)|unsubscribe|don'?t (message|text|send|contact)|(messages?|msgs?) (band|mat bhej\w*|na bhej\w*)|band kar(o|do|dijiye|de|en)?|mat bhej(o|na|iye|e)|remove my number|opt out)\b/],
  ["resume_alerts", /\b(resume (my |the )?alerts?|alerts? (wapas|vapas|phir se|chalu|on|shuru)( kar\w*)?|turn (on|back on) (my |the )?alerts|start (the )?alerts again)\b/],
  ["cancel_request", new RegExp(String.raw`\b(cancel (my|the|this)?\s*request|request (cancel|radd)|no longer need(ed)? blood|blood (is )?not needed|${BLOOD} (ki )?(ab )?(nahi|mat) (chahiye|zaroorat)|(ab )?(nahi|koi) zaroorat nahi|cancel kar(o|do|dijiye|na)?|blood mil gaya|arrange ho gaya)\b`)],
  ["track_request", /\b(track|status of (my|the) request|update on (my|the) request|any donors?( yet| found)?|(request|application|arzi)\b.*\b(kaha|status|pahuncha|kya hua|update|kab tak)|kaha tak|koi (donor|update|khabar) (mila|aaya|aayi)|mera request|meri request|request status|where is my request|any update|kya hua)\b/],
  ["register_donor", new RegExp(String.raw`\b(register|sign ?up|become a donor|be a donor|want to (donate|give blood|be a donor)|i want to give blood|donor (banna|banana|ban\w*|bnna)|(blood|khoon) (dena|daan|donate kar\w*|de sakta|de sakti)|khoon ?daan|raktdaan|rakt ?daan|donate (karna|karunga|karungi|blood)|i('d| would) like to donate|donor register|donor (kaise|kese) ban\w*)\b`)],
  // A typo'd one-word command ("reqest", "emergancy") is corrected to the command itself.
  ["create_request", /^(request|new request|blood request|emergency)$/],
  ["track_request", /^(track|track request)$/],
  ["register_donor", /^(register|donate)$/],
  ["create_request", new RegExp(String.raw`\b${NEED}\b.*\b${BLOOD}\b|\b${BLOOD}\b.*\b${NEED}\b|\b${GROUP}(?=\s|$).*\b(${NEED}|ki zaroorat)\b|\b${NEED}\b.*\b${GROUP}(?=\s|$)|\b(blood|khoon) (ki|ka) (zaroorat|intezaam|arrangement)|\b(patient|mareez|marij|mariz) (ko|ke liye) (blood|khoon)`)],
  ["donor_interested", /\b(i can help|i can donate|i am available|i'?m available|count me in|i will (come|donate)|i'?ll (come|donate)|main (aa|aaunga|aaungi|donate kar) ?(sakta|sakti|dunga|dungi)?|mai (aa|aaunga|aaungi) ?(sakta|sakti)?|haan main ready|ready to donate)\b/],
  ["donor_unavailable", /\b(can'?t (come|donate|make it|help)|cannot (come|donate)|not available|unavailable|nahi aa (sakta|sakti|paunga|paungi|paaunga)|busy (hu|hoon|hun)|abhi nahi|out of (town|station))\b/],
  ["more_info", /\b(more (info|information|details)|where is (the )?hospital|hospital (kaha|address|kidhar)|address (kya|what|batao|bhejo)|details (do|bhejo|batao))\b/],
  ["view_profile", /\b((my|meri|mera) (donor )?(profile|details)|show (my )?profile|my registration)\b/],
  ["update_profile", /\b((change|update|edit|badal\w*) (my |mera |meri )?(city|name|naam|blood group|details|address|location|area|number)|(city|naam|address|area|location) badal\w*)\b/],
  ["donor_status", /\b(am i (still )?(registered|available|active)|my (donor )?status|alerts? (on|off) (hai|hain|hai kya)\??)\b/],
  ["help", /\b(help|menu|options|what can you do|madad|sahayata|kya kar sakte|how (does|do) (this|it|you) work|kaise kaam|guide me)\b/],
  ["greeting", /^(hi+|hello|hey+|hy|namaste|namaskar|pranam|ram ram|radhe radhe|jai (shri|shree) (ram|krishna)|sat sri akal|salaam|salam|assalam\w*|good (morning|afternoon|evening)|kaise ho|kya haal)\b/],
];

const BLOOD_GROUP_TEXT = /\b(AB|A|B|O)\s*(\+|-|−|\+ve|-ve|pos(?:itive)?|neg(?:ative)?)(?=\s|$|[.,!])/i;
const COMPONENT_TEXT = /\b(whole blood|prbc|packed red cells?|red cells?|platelets?|sdp|plasma|ffp)\b/i;
const UNITS_TEXT = /\b(\d{1,2}|one|two|three|four|five|ek|do|teen|char|chaar|paanch|panch)\s*(units?|bags?|bottles?|unit)\b/i;
const NUMBER_WORDS: Record<string, number> = { one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, chaar: 4, five: 5, paanch: 5, panch: 5 };
const IN_CITY_TEXT = /\b(?:in|at)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*(?:[.,!]|$)/;
const CITY_MEIN_TEXT = /\b([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:mein|me|mai|main)\b/;
const TIME_TEXT = /\b(now|asap|immediately|urgent(?:ly)?|today(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?|tonight|tomorrow(?:\s+(?:morning|evening|\d{1,2}(?::\d{2})?\s*(?:am|pm)))?|in\s+\d{1,2}\s*(?:hours?|hrs?)|abhi|turant|jaldi)\b/i;

const units = (text: string): number | null => {
  const m = UNITS_TEXT.exec(text);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  return n ? Math.min(20, Math.max(1, n)) : null;
};

/** Keyword intent plus the obvious entities, for when AI is off or unavailable. */
export function classifyByKeywords(original: string): Interpretation {
  // Details are read from the original casing, with common Devanagari words transliterated.
  const text = transliterateHindi(original);
  const normalised = normaliseForIntent(original);
  const intent = RULES.find(([, pattern]) => pattern.test(normalised))?.[0] ?? "other";
  const group = BLOOD_GROUP_TEXT.exec(text);
  const time = TIME_TEXT.exec(text)?.[1] ?? null;
  const city = intent === "create_request" ? (IN_CITY_TEXT.exec(text)?.[1] ?? CITY_MEIN_TEXT.exec(text)?.[1] ?? null) : null;
  return {
    intent,
    entities: {
      bloodGroup: group ? group[0].trim() : null,
      component: COMPONENT_TEXT.exec(text)?.[1] ?? null,
      units: units(text),
      city: city && !/^(Blood|Khoon|Hospital|Emergency|Urgent)$/i.test(city) ? city : null,
      locality: null,
      hospitalName: null,
      requiredBy: time && /^(urgent|abhi|turant|jaldi)/i.test(time) ? "now" : time,
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
