import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServerEnv } from "@/lib/env";

/**
 * OTP_PROVIDER=whatsapp_web (pilot): sign-in codes go from the phone linked to the
 * WhatsApp Web worker, through the MongoDB outbox, so the web app never calls the worker
 * directly (they may run on different machines).
 */
const status = vi.hoisted(() => ({ value: { workerOnline: true, state: "connected" } as { workerOnline: boolean; state: string } }));
const queueSignInCode = vi.hoisted(() => vi.fn());

vi.mock("@/server/whatsapp/connection-store", () => ({ readConnectionStatus: vi.fn(async () => status.value) }));
vi.mock("@/server/messaging/queue", () => ({ queueSignInCode }));

const { whatsAppWebDevOtpProvider } = await import("@/server/otp-delivery");

const input = { phoneE164: "+919000012345", code: "482913", expiresInMinutes: 5, requestId: "req-1" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  queueSignInCode.mockReset();
  status.value = { workerOnline: true, state: "connected" };
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

  it("queues the code in the outbox when the worker is connected, expiring with the code", async () => {
    queueSignInCode.mockResolvedValue({ outcome: "queued", messageId: "m1", status: "queued" });
    const sent = await whatsAppWebDevOtpProvider().send(input);
    expect(sent).toEqual({});
    expect(queueSignInCode).toHaveBeenCalledWith({ phoneE164: "+919000012345", code: "482913", minutes: 5, requestId: "req-1" });
  });

  it("falls back to the labelled development print when no phone is linked or the worker is down", async () => {
    const print = vi.spyOn(console, "warn").mockImplementation(() => {});
    status.value = { workerOnline: true, state: "qr_required" };
    expect(await whatsAppWebDevOtpProvider().send(input)).toEqual({ channel: "development" });
    status.value = { workerOnline: false, state: "disconnected" };
    expect(await whatsAppWebDevOtpProvider().send(input)).toEqual({ channel: "development" });
    expect(print.mock.calls.flat().join("\n")).toMatch(/DEVELOPMENT OTP[\s\S]*NOT SENT VIA WHATSAPP/);
    expect(queueSignInCode).not.toHaveBeenCalled();
  });

  it("fails in production when no worker is connected (never prints a code there)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTP_ALLOW_WHATSAPP_WEB_IN_PROD", "true");
    status.value = { workerOnline: false, state: "disconnected" };
    await expect(whatsAppWebDevOtpProvider().send(input)).rejects.toThrow(/worker not connected/);
    expect(queueSignInCode).not.toHaveBeenCalled();
  });

  it("fails honestly when the outbox refuses the message (no silent fallback)", async () => {
    queueSignInCode.mockResolvedValue({ outcome: "suppressed", messageId: null, status: "suppressed", reason: "OPTED_OUT" });
    await expect(whatsAppWebDevOtpProvider().send(input)).rejects.toThrow(/OPTED_OUT/);
  });
});
