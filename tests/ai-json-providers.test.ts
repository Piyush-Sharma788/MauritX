import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "@/lib/ai/config";
import { classifyByKeywords } from "@/server/ai/interpret";
import { callJsonModel, jsonInstruction } from "@/server/ai/json-llm";
import { JsonLlmAiProvider } from "@/server/ai/json-provider";
import { AiProviderError } from "@/server/ai/provider";
import { aiOutputFormatSchema, interpretationSchema } from "@/server/ai/schema";

/** Gemini and OpenAI providers over plain HTTPS (fetch is stubbed; no real calls). */
const valid = {
  intent: "create_request",
  entities: { bloodGroup: "B+", component: null, units: 2, city: "Lucknow", locality: null, hospitalName: null, requiredBy: "now", requestId: null },
  confidence: 0.9,
  missing_fields: ["hospitalName"],
  requires_confirmation: true,
  suggested_response: "Which hospital is the patient in?",
};
const gemini: AiConfig = { provider: "gemini", apiKey: "g-key", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", timeoutMs: 5000, maxCallsPerNumberPerHour: 20 };
const openai: AiConfig = { provider: "openai", apiKey: "o-key", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutMs: 5000, maxCallsPerNumberPerHour: 20 };
const call = { system: "Classify.", user: "khoon chahiye B+ Lucknow", schema: aiOutputFormatSchema, timeoutMs: 5000 };

function reply(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const geminiBody = (text: string, finishReason = "STOP") => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });
const openaiBody = (content: string | null, finish_reason = "stop", refusal: string | null = null) => ({ choices: [{ message: { content, refusal }, finish_reason }] });
const errorCode = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof AiProviderError ? [e.code, e.status] : e));

afterEach(() => vi.unstubAllGlobals());

describe("Gemini", () => {
  it("sends the key in a header (never the URL), asks for JSON, and returns the parsed object", async () => {
    const fetchMock = reply(200, geminiBody(JSON.stringify(valid)));
    const out = await callJsonModel(gemini, call);
    expect(interpretationSchema.parse(out)).toEqual(valid);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(url).not.toContain("g-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction.parts[0].text).toContain('"intent"');
    expect(body.contents[0].parts[0].text).toBe("khoon chahiye B+ Lucknow");
  });

  it("accepts JSON wrapped in a code fence", async () => {
    reply(200, geminiBody("```json\n" + JSON.stringify(valid) + "\n```"));
    expect(await callJsonModel(gemini, call)).toEqual(valid);
  });

  it("maps safety blocks, truncation, non-JSON and HTTP errors (e.g. free-tier 429) to provider errors", async () => {
    reply(200, geminiBody("", "SAFETY"));
    expect(await errorCode(callJsonModel(gemini, call))).toEqual(["REFUSED", null]);
    reply(200, { promptFeedback: { blockReason: "OTHER" } });
    expect(await errorCode(callJsonModel(gemini, call))).toEqual(["REFUSED", null]);
    reply(200, geminiBody('{"intent": "create', "MAX_TOKENS"));
    expect(await errorCode(callJsonModel(gemini, call))).toEqual(["TRUNCATED", null]);
    reply(200, geminiBody("Sure! Here you go."));
    expect(await errorCode(callJsonModel(gemini, call))).toEqual(["NO_OUTPUT", null]);
    reply(429, { error: { message: "quota" } });
    expect(await errorCode(callJsonModel(gemini, call))).toEqual(["TRANSPORT", 429]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await errorCode(callJsonModel(gemini, call))).toEqual(["TRANSPORT", null]);
  });
});

describe("OpenAI", () => {
  it("uses a bearer token and JSON mode, and returns the parsed object", async () => {
    const fetchMock = reply(200, openaiBody(JSON.stringify(valid)));
    expect(await callJsonModel(openai, call)).toEqual(valid);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer o-key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gpt-4o-mini", response_format: { type: "json_object" } });
    expect(body.messages[0].role).toBe("system");
  });

  it("maps refusals, content filters and truncation", async () => {
    reply(200, openaiBody(null, "stop", "I can't help with that."));
    expect(await errorCode(callJsonModel(openai, call))).toEqual(["REFUSED", null]);
    reply(200, openaiBody("{}", "content_filter"));
    expect(await errorCode(callJsonModel(openai, call))).toEqual(["REFUSED", null]);
    reply(200, openaiBody('{"intent":', "length"));
    expect(await errorCode(callJsonModel(openai, call))).toEqual(["TRUNCATED", null]);
    reply(401, { error: { message: "bad key" } });
    expect(await errorCode(callJsonModel(openai, call))).toEqual(["TRANSPORT", 401]);
  });
});

describe("as the bot's AI provider", () => {
  it("puts the bot's own prompt, the sender context and the exact output schema in the request", async () => {
    const fetchMock = reply(200, geminiBody(JSON.stringify(valid)));
    await new JsonLlmAiProvider(gemini).interpret("khoon chahiye", { role: "unknown", hasRecentAlert: false, hasOpenRequest: false });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.systemInstruction.parts[0].text).toMatch(/MarutiX[\s\S]*untrusted[\s\S]*JSON Schema/);
    expect(body.contents[0].parts[0].text).toMatch(/Sender context: \{"role":"unknown"[\s\S]*<message>\nkhoon chahiye\n<\/message>/);
  });

  it("describes every property of the schema to the model", () => {
    const instruction = jsonInstruction(aiOutputFormatSchema);
    for (const key of ["intent", "entities", "bloodGroup", "confidence", "missing_fields", "requires_confirmation", "suggested_response"]) expect(instruction).toContain(`"${key}"`);
  });

  it("keyword rules still answer on their own (the fallback when the AI fails)", () => {
    expect(classifyByKeywords("khoon chahiye B+ Lucknow mein").intent).toBe("create_request");
  });
});
