import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServerEnv } from "@/lib/env";
import { whatsAppWebDevOtpProvider } from "@/server/otp-delivery";

/**
 * OTP_PROVIDER=whatsapp_web (development only): sign-in codes go from the phone linked
 * to the WhatsApp Web pilot worker, through its authenticated loopback control channel.
 */
const input = { phoneE164: "+919000012345", code: "482913", expiresInMinutes: 5, requestId: "req-1" };
const workerReplies = (status: number, body: unknown) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OTP_PROVIDER=whatsapp_web", () => {
  it("is refused in production", () => {
    const base = {
      MONGODB_URI: "mongodb://x/y",
      APP_BASE_URL: "https://marutix.example",
      AUTH_JWT_SECRET: randomBytes(32).toString("base64"),
      OTP_HASH_SECRET: randomBytes(32).toString("base64"),
      PII_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      OTP_PROVIDER: "whatsapp_web",
    };
    const prod = parseServerEnv({ ...base, NODE_ENV: "production" });
    expect(prod.success).toBe(false);
    expect(JSON.stringify(prod.error?.issues)).toMatch(/development only/);
    expect(parseServerEnv({ ...base, NODE_ENV: "development" }).success).toBe(true);
  });

  it("sends the code from the linked phone through the worker's authenticated control channel", async () => {
    const fetchMock = workerReplies(200, { providerMessageId: "true_91900@c.us_ABC" });
    const sent = await whatsAppWebDevOtpProvider().send(input);
    expect(sent).toEqual({ providerMessageId: "true_91900@c.us_ABC" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/send-otp$/);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${process.env.WHATSAPP_WEB_WORKER_SECRET}`);
    expect(JSON.parse(String(init.body))).toEqual({ phone: "+919000012345", code: "482913", minutes: 5 });
  });

  it("falls back to the labelled development print when no phone is linked or the worker is down", async () => {
    const print = vi.spyOn(console, "warn").mockImplementation(() => {});
    workerReplies(503, { error: "not_connected" });
    expect(await whatsAppWebDevOtpProvider().send(input)).toEqual({ channel: "development" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await whatsAppWebDevOtpProvider().send(input)).toEqual({ channel: "development" });
    expect(print.mock.calls.flat().join("\n")).toMatch(/DEVELOPMENT OTP[\s\S]*NOT SENT VIA WHATSAPP/);
  });

  it("fails honestly when the number isn't on WhatsApp (no silent fallback)", async () => {
    workerReplies(422, { error: "not_on_whatsapp" });
    await expect(whatsAppWebDevOtpProvider().send(input)).rejects.toThrow(/not_on_whatsapp/);
  });
});
