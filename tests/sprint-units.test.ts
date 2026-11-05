import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAiConfig, resetAiConfigForTests } from "@/lib/ai/config";
import { definedEnv } from "@/lib/config/env-source";
import { getCoordinationConfig, resetCoordinationConfigForTests } from "@/lib/coordination/config";
import { getDiscoveryConfig, resetDiscoveryConfigForTests } from "@/lib/discovery/config";
import { getEmailConfig, resetEmailConfigForTests } from "@/lib/email/config";
import { getMessagingProviderName, resetWhatsAppCloudConfigForTests } from "@/lib/whatsapp/cloud-config";
import { getWhatsAppWebConfig, resetWhatsAppWebConfigForTests } from "@/lib/whatsapp-web/config";
import { clientIpFrom } from "@/lib/api/handler";
import { checkServerConfiguration, weakSecret } from "@/lib/security/config-check";
import { CLOUD_ERROR, sendTemplateMessage, sendTextMessage, WhatsAppApiError } from "@/lib/whatsapp/client";
import { chooseCloudMessage, toMessagingError } from "@/server/messaging/cloud-provider";
import { emergencyAlertParams, requestConfirmationParams, templateParam } from "@/server/messaging/cloud-templates";
import { signatureFor, toInboundMessage, verifySignature, verifySubscription } from "@/server/messaging/cloud-webhook";
import { MessagingError } from "@/server/messaging/provider";
import { whatsAppOtpProvider } from "@/server/otp-delivery";

const NOW = new Date("2026-11-05T06:00:00Z");
const HOUR = 60 * 60 * 1000;
const templates = { emergencyAlert: "marutix_emergency_alert", requestConfirmation: "marutix_request_confirmation", language: "en" };
const ctx = (overrides: Partial<Parameters<typeof chooseCloudMessage>[0]> = {}) => ({ kind: "bot_reply" as const, templateParams: null, lastInboundAt: null, now: NOW, ...overrides });

describe("Cloud API: text or template", () => {
  it("sends free-form text inside the 24-hour window, with a safety margin", () => {
    expect(chooseCloudMessage(ctx({ lastInboundAt: new Date(NOW.getTime() - 2 * HOUR) }), templates)).toEqual({ type: "text" });
    expect(chooseCloudMessage(ctx({ lastInboundAt: new Date(NOW.getTime() - 23.95 * HOUR) }), templates)).toEqual({ type: "blocked" });
  });
  it("uses the kind's approved template outside the window", () => {
    expect(chooseCloudMessage(ctx({ kind: "emergency_request", templateParams: ["B+"] }), templates)).toEqual({ type: "template", name: "marutix_emergency_alert", params: ["B+"] });
    expect(chooseCloudMessage(ctx({ kind: "request_confirmation", templateParams: ["MX-1", "url"] }), templates)).toMatchObject({ type: "template", name: "marutix_request_confirmation" });
  });
  it("refuses kinds without a template, and templates without values", () => {
    expect(chooseCloudMessage(ctx({ kind: "requester_update" }), templates)).toEqual({ type: "blocked" });
    expect(chooseCloudMessage(ctx({ kind: "emergency_request", templateParams: null }), templates)).toEqual({ type: "blocked" });
    expect(chooseCloudMessage(ctx({ kind: "emergency_request", templateParams: ["x"] }), { ...templates, emergencyAlert: null })).toEqual({ type: "blocked" });
  });
});

describe("Cloud API: error mapping for retries", () => {
  const code = (e: MessagingError) => [e.code, e.retryable];
  it.each([
    [new WhatsAppApiError(400, CLOUD_ERROR.OUTSIDE_SERVICE_WINDOW, false), ["OUTSIDE_SERVICE_WINDOW", false]],
    [new WhatsAppApiError(400, CLOUD_ERROR.UNDELIVERABLE, false), ["NOT_ON_WHATSAPP", false]],
    [new WhatsAppApiError(400, CLOUD_ERROR.RATE_LIMIT, true), ["SEND_FAILED", true]],
    [new WhatsAppApiError(503, null, true), ["SEND_FAILED", true]],
    [new WhatsAppApiError(401, CLOUD_ERROR.ACCESS_TOKEN, false), ["REJECTED", false]],
    [new WhatsAppApiError(null, null, false), ["SEND_TIMEOUT", false]],
    [new WhatsAppApiError(null, null, true), ["SEND_FAILED", true]],
  ])("%s", (error, expected) => {
    expect(code(toMessagingError(error))).toEqual(expected);
  });
});

describe("Cloud API: Graph requests (mocked fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const api = { accessToken: "tok", phoneNumberId: "1234567890", graphApiVersion: "v26.0" };

  it("sends text without link previews to the number without '+'", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.A" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendTextMessage(api, { to: "+919876543210", body: "Hello" })).toEqual({ messageId: "wamid.A" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v26.0/1234567890/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "919876543210", type: "text", text: { preview_url: false, body: "Hello" } });
  });

  it("classifies Graph errors and never retries a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 131047 } }), { status: 400 })));
    await expect(sendTextMessage(api, { to: "+919876543210", body: "x" })).rejects.toMatchObject({ httpStatus: 400, providerCode: 131047, retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }));
    await expect(sendTextMessage(api, { to: "+919876543210", body: "x" })).rejects.toMatchObject({ httpStatus: null, retryable: false });
  });

  it("sends sign-in codes with the authentication template (code in body and copy-code button)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OTP" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = whatsAppOtpProvider({ ...api, templateName: "marutix_login_code", languageCode: "en" });
    expect(await provider.send({ phoneE164: "+919876543210", code: "482913", expiresInMinutes: 5, requestId: "r" })).toEqual({ providerMessageId: "wamid.OTP" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.template).toEqual({
      name: "marutix_login_code",
      language: { code: "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "482913" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
      ],
    });
  });

  it("retries a sign-in code once on a server error, but not on a rejected template", async () => {
    const flaky = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.2" }] }), { status: 200 }));
    vi.stubGlobal("fetch", flaky);
    expect(await sendTemplateMessage(api, { to: "+919876543210", templateName: "t", languageCode: "en", components: [] })).toEqual({ messageId: "wamid.2" });
    expect(flaky).toHaveBeenCalledTimes(2);
    const rejected = vi.fn(async () => new Response(JSON.stringify({ error: { code: 132001 } }), { status: 400 }));
    vi.stubGlobal("fetch", rejected);
    await expect(sendTemplateMessage(api, { to: "+919876543210", templateName: "t", languageCode: "en", components: [] })).rejects.toBeInstanceOf(WhatsAppApiError);
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});

describe("Cloud API: webhook verification and parsing", () => {
  const secret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts only the exact HMAC-SHA256 of the raw body", () => {
    const sig = signatureFor(body, secret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(Buffer.from(body), sig.toUpperCase().replace("SHA256", "sha256"), secret)).toBe(true);
    expect(verifySignature(`${body} `, sig, secret)).toBe(false);
    expect(verifySignature(body, signatureFor(body, "another-secret-value-123456"), secret)).toBe(false);
    expect(verifySignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
  });

  it("answers the subscription handshake only for our token", () => {
    const p = (q: string) => new URLSearchParams(q);
    expect(verifySubscription(p("hub.mode=subscribe&hub.verify_token=tok-1234567890abcdef&hub.challenge=1158201444"), "tok-1234567890abcdef")).toBe("1158201444");
    expect(verifySubscription(p("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"), "tok-1234567890abcdef")).toBeNull();
    expect(verifySubscription(p("hub.mode=unsubscribe&hub.verify_token=tok-1234567890abcdef&hub.challenge=1"), "tok-1234567890abcdef")).toBeNull();
    expect(verifySubscription(p("hub.mode=subscribe&hub.verify_token=tok-1234567890abcdef&hub.challenge=<script>"), "tok-1234567890abcdef")).toBeNull();
  });

  it("turns supported messages into pipeline input and ignores the rest", () => {
    expect(toInboundMessage({ from: "919876543210", id: "wamid.1", type: "text", text: { body: "REGISTER" } })).toEqual({ providerMessageId: "wamid.1", fromE164: "+919876543210", input: { type: "text", text: "REGISTER" } });
    expect(toInboundMessage({ from: "919876543210", id: "w2", type: "button", button: { text: "1" } })?.input).toEqual({ type: "text", text: "1" });
    expect(toInboundMessage({ from: "919876543210", id: "w3", type: "interactive", interactive: { button_reply: { title: "Interested" } } })?.input).toEqual({ type: "text", text: "Interested" });
    expect(toInboundMessage({ from: "919876543210", id: "w4", type: "location", location: { latitude: 25.43, longitude: 81.84 } })?.input).toEqual({ type: "location", latitude: 25.43, longitude: 81.84 });
    expect(toInboundMessage({ from: "447700900123", id: "w5", type: "text", text: { body: "hi" } })).toBeNull();
    expect(toInboundMessage({ from: "919876543210", id: "w6", type: "image" })).toBeNull();
    expect(toInboundMessage({ from: "91x", id: "w7", type: "text", text: { body: "hi" } })).toBeNull();
  });

  it("flattens template values to single lines", () => {
    expect(templateParam("a\nb\t c     d")).toBe("a b c d");
    const params = emergencyAlertParams({ publicRequestId: "MX-7K3Q9P2A", hospitalName: "City Hospital", locality: "Civil Lines", city: "Prayagraj", bloodGroup: "B+", component: "platelets", unitsRequested: 2, neededBy: NOW, distanceKm: 3.2 });
    expect(params).toHaveLength(8);
    expect(params.slice(0, 3)).toEqual(["B+", "Platelets", "2"]);
    expect(params[5]).toBe("about 3 km away");
    expect(params.every((p) => !/[\n\t]/.test(p))).toBe(true);
    expect(requestConfirmationParams("MX-1", "https://x/track/t")).toEqual(["MX-1", "https://x/track/t"]);
  });
});

describe("Security: client IP behind proxies", () => {
  const h = (xff?: string, real?: string) => new Headers({ ...(xff ? { "x-forwarded-for": xff } : {}), ...(real ? { "x-real-ip": real } : {}) });
  it("trusts only the entry our own proxy appended", () => {
    // The client prepended a fake address; one trusted proxy appended the real one.
    expect(clientIpFrom(h("1.1.1.1, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIpFrom(h("1.1.1.1, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIpFrom(h("203.0.113.9"), 3)).toBe("203.0.113.9");
    expect(clientIpFrom(h(undefined, "198.51.100.4"), 1)).toBe("198.51.100.4");
    expect(clientIpFrom(h("1.1.1.1", "2.2.2.2"), 0)).toBe("unknown");
  });
});

describe("Security: startup configuration", () => {
  it("flags placeholder and non-random secrets", () => {
    expect(weakSecret("please-change-me-before-production-123")).toMatch(/placeholder/);
    expect(weakSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toMatch(/distinct/);
    expect(weakSecret("q8Vx2LpZr4Nt7Wm1Ys5Kd9Hb3Jf6Gc0E")).toBeNull();
  });

  it("refuses unsafe production settings but only warns in development", () => {
    const base = { ...process.env, NODE_ENV: "production", WHATSAPP_APP_SECRET: "your_secret_here_1234567890" };
    const prod = checkServerConfiguration("web", base);
    expect(prod.errors.join("\n")).toMatch(/APP_BASE_URL must use https/);
    expect(prod.errors.join("\n")).toMatch(/WHATSAPP_APP_SECRET looks like a placeholder/);
    const reused = checkServerConfiguration("web", { ...base, WHATSAPP_APP_SECRET: undefined, WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.AUTH_JWT_SECRET });
    expect(reused.errors.join("\n")).toMatch(/AUTH_JWT_SECRET and WHATSAPP_WEBHOOK_VERIFY_TOKEN must be different/);
    const dev = checkServerConfiguration("web", { ...process.env, NODE_ENV: "development", WHATSAPP_APP_SECRET: "your_secret_here_1234567890" });
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.join("\n")).toMatch(/placeholder/);
  });

  it("requires the WhatsApp Web settings only for the WhatsApp worker", () => {
    expect(checkServerConfiguration("whatsapp-worker").errors).toEqual([]);
    expect(checkServerConfiguration("jobs-worker").errors).toEqual([]);
  });
});

describe("Configuration: empty values from .env.example", () => {
  it("treats KEY= as unset in every config module", () => {
    expect(definedEnv({ A: "", B: "  ", C: "x", D: undefined })).toEqual({ C: "x" });
    const empties = readFileSync(".env.example", "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=$/.exec(l.trim())?.[1]).filter((k): k is string => Boolean(k));
    expect(empties).toEqual(expect.arrayContaining(["WHATSAPP_WEBHOOK_VERIFY_TOKEN", "DISCOVERY_CONTACT_EMAIL", "COORDINATOR_CONTACT_EMAIL", "EMAIL_REPLY_TO"]));
    const saved = Object.fromEntries(empties.map((k) => [k, process.env[k]]));
    const resetAll = () => [resetAiConfigForTests, resetCoordinationConfigForTests, resetDiscoveryConfigForTests, resetEmailConfigForTests, resetWhatsAppCloudConfigForTests, resetWhatsAppWebConfigForTests].forEach((r) => r());
    try {
      for (const k of empties) if (process.env[k] === undefined) process.env[k] = "";
      resetAll();
      expect(() => [getAiConfig(), getCoordinationConfig(), getDiscoveryConfig(), getEmailConfig(), getMessagingProviderName(), getWhatsAppWebConfig()]).not.toThrow();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      resetAll();
    }
  });
});
