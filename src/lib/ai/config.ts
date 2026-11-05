import "server-only";
import { definedEnv } from "@/lib/config/env-source";
import { z } from "zod";

/**
 * Optional AI understanding for the WhatsApp bot. Off unless AI_PROVIDER is
 * set; the bot works fully on commands without it.
 */
const schema = z
  .object({
    AI_PROVIDER: z.enum(["none", "anthropic"]).default("none"),
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL: z.string().min(1).default("claude-opus-5-5"),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
    AI_MAX_CALLS_PER_NUMBER_PER_HOUR: z.coerce.number().int().min(1).max(200).default(20),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY" });
    }
  });

export interface AiConfig {
  provider: "none" | "anthropic";
  apiKey?: string;
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
  cached = {
    provider: env.AI_PROVIDER,
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.AI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    maxCallsPerNumberPerHour: env.AI_MAX_CALLS_PER_NUMBER_PER_HOUR,
  };
  return cached;
}

export function resetAiConfigForTests() {
  cached = undefined;
}
