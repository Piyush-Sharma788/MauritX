import "server-only";
import { z } from "zod";
import type { AiConfig } from "@/lib/ai/config";
import { AiProviderError } from "@/server/ai/provider";

/**
 * One JSON-producing call to Google Gemini or the OpenAI API (or any
 * OpenAI-compatible endpoint), over plain HTTPS: no SDKs. The model is asked
 * for a JSON object matching `schema`; the caller still validates the result
 * with its own strict Zod schema and falls back to keyword rules on any error.
 * Nothing here is trusted.
 */

export interface JsonCall {
  system: string;
  user: string;
  /** The output shape, sent to the model as a JSON Schema. */
  schema: z.ZodType;
  timeoutMs: number;
}

/** The instruction appended to every system prompt, with the exact JSON Schema to follow. */
export function jsonInstruction(schema: z.ZodType): string {
  const jsonSchema = z.toJSONSchema(schema);
  delete (jsonSchema as { $schema?: string }).$schema;
  return `\n\nReply with ONE JSON object and nothing else (no markdown, no code fences). It must match this JSON Schema exactly, with every property present (use null where the schema allows it):\n${JSON.stringify(jsonSchema)}`;
}

function parseJsonText(text: string): unknown {
  // Some models still wrap JSON in a code fence despite instructions.
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AiProviderError("NO_OUTPUT");
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new AiProviderError("TRANSPORT");
  }
  if (!response.ok) throw new AiProviderError("TRANSPORT", response.status);
  try {
    return await response.json();
  } catch {
    throw new AiProviderError("NO_OUTPUT", response.status);
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** Gemini generateContent with JSON output (https://ai.google.dev/api/generate-content). */
async function callGemini(config: AiConfig, call: JsonCall): Promise<unknown> {
  const url = `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`;
  const data = (await post(
    url,
    // The key goes in a header, never in the URL (URLs end up in logs).
    { "x-goog-api-key": config.apiKey ?? "" },
    {
      systemInstruction: { parts: [{ text: call.system + jsonInstruction(call.schema) }] },
      contents: [{ role: "user", parts: [{ text: call.user }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2048 },
    },
    call.timeoutMs,
  )) as GeminiResponse;
  if (data.promptFeedback?.blockReason) throw new AiProviderError("REFUSED");
  const candidate = data.candidates?.[0];
  if (!candidate) throw new AiProviderError("NO_OUTPUT");
  if (candidate.finishReason && ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(candidate.finishReason)) throw new AiProviderError("REFUSED");
  if (candidate.finishReason === "MAX_TOKENS") throw new AiProviderError("TRUNCATED");
  const text = (candidate.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new AiProviderError("NO_OUTPUT");
  return parseJsonText(text);
}

interface OpenAiResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
}

/** Chat Completions with JSON mode (works with OpenAI and OpenAI-compatible endpoints). */
async function callOpenAi(config: AiConfig, call: JsonCall): Promise<unknown> {
  const data = (await post(
    `${config.baseUrl}/chat/completions`,
    { Authorization: `Bearer ${config.apiKey ?? ""}` },
    {
      model: config.model,
      messages: [
        { role: "system", content: call.system + jsonInstruction(call.schema) },
        { role: "user", content: call.user },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 2048,
    },
    call.timeoutMs,
  )) as OpenAiResponse;
  const choice = data.choices?.[0];
  if (!choice) throw new AiProviderError("NO_OUTPUT");
  if (choice.message?.refusal || choice.finish_reason === "content_filter") throw new AiProviderError("REFUSED");
  if (choice.finish_reason === "length") throw new AiProviderError("TRUNCATED");
  const text = choice.message?.content ?? "";
  if (!text.trim()) throw new AiProviderError("NO_OUTPUT");
  return parseJsonText(text);
}

/** Raw JSON from the configured provider (gemini or openai). Throws AiProviderError. */
export function callJsonModel(config: AiConfig, call: JsonCall): Promise<unknown> {
  if (config.provider === "gemini") return callGemini(config, call);
  if (config.provider === "openai") return callOpenAi(config, call);
  throw new AiProviderError("TRANSPORT");
}
