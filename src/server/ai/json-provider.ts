import "server-only";
import type { AiConfig } from "@/lib/ai/config";
import { INTERPRET_SYSTEM_PROMPT } from "@/server/ai/anthropic";
import { callJsonModel } from "@/server/ai/json-llm";
import type { AiMessageContext, AiProvider } from "@/server/ai/provider";
import { aiOutputFormatSchema } from "@/server/ai/schema";

/**
 * WhatsApp message understanding through Google Gemini or the OpenAI API, with the same
 * prompt and output schema as the Claude provider. interpret.ts validates the result and
 * falls back to keyword rules on any error.
 */
export class JsonLlmAiProvider implements AiProvider {
  readonly name: string;

  constructor(private readonly config: AiConfig) {
    this.name = config.provider;
  }

  interpret(text: string, context: AiMessageContext): Promise<unknown> {
    return callJsonModel(this.config, {
      system: INTERPRET_SYSTEM_PROMPT,
      user: `Sender context: ${JSON.stringify(context)}\n<message>\n${text}\n</message>`,
      schema: aiOutputFormatSchema,
      timeoutMs: this.config.timeoutMs,
    });
  }
}
