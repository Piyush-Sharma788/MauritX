import "server-only";
import { definedEnv } from "@/lib/config/env-source";
import { z } from "zod";

/**
 * Optional AI understanding for the WhatsApp bot and discovery. Off unless
 * AI_PROVIDER is set; the bot works fully on commands without it.
 *
 * - gemini: Google Gemini API (Google AI Studio key; has a free tier).
 * - openai: OpenAI API, or any OpenAI-compatible endpoint via OPENAI_BASE_URL.
 * - anthropic: Claude.
 */
export const AI_PROVIDERS = ["none", "gemini", "openai", "anthropic"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** Used when AI_MODEL isn't set. Model names change over time: set AI_MODEL to override. */
export const DEFAULT_AI_MODELS: Record<Exclude<AiProviderName, "none">, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-opus-5-5",
};

const KEY_FOR = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" } as const;

const schema = z
  .object({
    AI_PROVIDER: z.enum(AI_PROVIDERS).default("none"),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_BASE_URL: z.url().default("https://generativelanguage.googleapis.com/v1beta"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL: z.string().min(1).optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
    AI_MAX_CALLS_PER_NUMBER_PER_HOUR: z.coerce.number().int().min(1).max(200).default(20),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === "none") return;
    const key = KEY_FOR[env.AI_PROVIDER];
    if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: `AI_PROVIDER=${env.AI_PROVIDER} requires ${key}` });
  });

export interface AiConfig {
  provider: AiProviderName;
  apiKey?: string;
  /** API base URL for gemini/openai (no trailing slash). */
  baseUrl?: string;
  model: string;
  timeoutMs: number;
  maxCallsPerNumberPerHour: number;
}

let cached: AiConfig | undefined;

export function getAiConfig(): AiConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid AI configuration:\n${issues.join("\n")}`);
  }
  const env = parsed.data;
  const provider = env.AI_PROVIDER;
  cached = {
    provider,
    apiKey: provider === "none" ? undefined : env[KEY_FOR[provider]],
    baseUrl: provider === "gemini" ? env.GEMINI_BASE_URL.replace(/\/$/, "") : provider === "openai" ? env.OPENAI_BASE_URL.replace(/\/$/, "") : undefined,
    model: env.AI_MODEL ?? (provider === "none" ? DEFAULT_AI_MODELS.anthropic : DEFAULT_AI_MODELS[provider]),
    timeoutMs: env.AI_TIMEOUT_MS,
    maxCallsPerNumberPerHour: env.AI_MAX_CALLS_PER_NUMBER_PER_HOUR,
  };
  return cached;
}

export function resetAiConfigForTests() {
  cached = undefined;
}
