import { afterEach, describe, expect, it, vi } from "vitest";
import { routeShape } from "@/lib/api/handler";
import { can, isStaffRole, PERMISSIONS, STAFF_ROLES } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { requestRetentionDays } from "@/lib/privacy/retention-config";
import { checkServerConfiguration } from "@/lib/security/config-check";
import { hashRecoveryCode } from "@/lib/security/crypto";
import { redactText } from "@/lib/security/redact";
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, otpauthUri, stepAt, totpAt, verifyTotp } from "@/lib/security/totp";
import { getSmsConfig, renderSmsOtp } from "@/lib/sms/config";
import { errorFingerprint } from "@/server/monitoring/report";
import { SmsApiError, twilioSmsOtpProvider } from "@/server/otp-delivery/sms";

/** Sprint 2: admin MFA, RBAC, redaction, retention settings and the SMS fallback (pure parts). */

// RFC 6238 Appendix B, SHA-1 key "12345678901234567890" (8-digit values; we use the last 6).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vectors", () => {
    for (const [seconds, code] of RFC_VECTORS) expect(totpAt(RFC_SECRET, stepAt(new Date(seconds * 1000)))).toBe(code);
  });

  it("round-trips base32 and makes 160-bit secrets", () => {
    const bytes = Buffer.from("hello, authenticator");
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it("accepts the current step and one step of drift, and nothing older", () => {
    const now = new Date(1_700_000_000_000);
    const step = stepAt(now);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
  });

  it("refuses a code from an already-used step (replay)", () => {
    const now = new Date(1_700_000_000_000);
    const step = stepAt(now);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, step - 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
  });

  it("builds an otpauth URI authenticator apps accept", () => {
    const uri = new URL(otpauthUri("JBSWY3DPEHPK3PXP", "+91 98XXX XX210"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(uri.searchParams.get("issuer")).toBe("MarutiX");
    expect(uri.searchParams.get("digits")).toBe("6");
  });

  it("makes unambiguous, unique recovery codes and hashes them independent of formatting", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
    expect(hashRecoveryCode("7k3q-9p2a")).toBe(hashRecoveryCode("7K3Q9P2A"));
    expect(hashRecoveryCode(" 7K3Q 9P2A ")).toBe(hashRecoveryCode("7K3Q-9P2A"));
    expect(hashRecoveryCode("7K3Q-9P2A")).not.toBe(hashRecoveryCode("7K3Q-9P2B"));
  });
});

describe("role permissions", () => {
  const SUPER_ONLY = ["institutions.verify", "operations.settings", "whatsapp.manage", "jobs.retry", "audit.read", "errors.read"] as const;

  it("gives coordinators day-to-day emergency work but not system controls", () => {
    for (const p of ["admin.access", "requests.manage", "coordination.manage", "institutions.review", "operations.read", "whatsapp.read", "messages.retry", "conversations.read"] as const) {
      expect(can("coordinator", p)).toBe(true);
    }
    for (const p of SUPER_ONLY) expect(can("coordinator", p)).toBe(false);
  });

  it("gives super admins (and the legacy admin role) everything", () => {
    for (const p of PERMISSIONS) {
      expect(can("super_admin", p)).toBe(true);
      expect(can("admin", p)).toBe(true);
    }
  });

  it("gives donors, institution users and unknown roles nothing", () => {
    for (const role of ["donor", "institution_user", "", "superadmin", "ADMIN"]) {
      expect(isStaffRole(role)).toBe(false);
      for (const p of PERMISSIONS) expect(can(role, p)).toBe(false);
    }
    expect([...STAFF_ROLES].sort()).toEqual(["admin", "coordinator", "super_admin"]);
  });
});

describe("redaction", () => {
  it("removes phone numbers in every common Indian format", () => {
    for (const phone of ["+919876543210", "919876543210", "09876543210", "9876543210", "98765 43210", "+91 98765 43210", "91-98765-43210"]) {
      expect(redactText(`send to ${phone} failed`)).toBe("send to [phone] failed");
    }
  });

  it("removes codes, emails, bearer tokens, query secrets and long opaque strings", () => {
    expect(redactText("code 482913 rejected")).toBe("code [code] rejected");
    expect(redactText("mail ops@hospital.example.in bounced")).toBe("mail [email] bounced");
    expect(redactText("Authorization: Bearer EAAGm0PX4ZCpsBAx")).toBe("Authorization: Bearer [secret]");
    expect(redactText("GET /r?token=abc.def&x=1")).toBe("GET /r?token=[secret]&x=1");
    expect(redactText('dup key: { tokenHash: "q2kLm9Qp2Rt7Vw1Xy4Bc6Dn8Fg0Hj5Ks1Mn9Pq2Rs3" }')).toBe('dup key: { tokenHash: "[secret]" }');
  });

  it("keeps what operators need: request IDs, ObjectIds, timestamps, route paths and counts", () => {
    const keep = "request 3f2b7c1e-9a4d-4e8b-b1c2-0d9e8f7a6b5c doc 65f1a2b3c4d5e6f7a8b9c0d1 at 2026-11-05T10:20:30.123Z took 1234 ms on /api/v1/admin/operations/failed-messages";
    expect(redactText(keep)).toBe(keep);
  });

  it("is applied by the logger to every string field", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("test.event", { errorMessage: "provider said +919876543210 is invalid, code 123456", count: 3 });
    const line = JSON.parse(String(spy.mock.calls[0][0]));
    spy.mockRestore();
    expect(line.errorMessage).toBe("provider said [phone] is invalid, code [code]");
    expect(line.count).toBe(3);
  });

  it("shapes routes and fingerprints errors without IDs splitting them", () => {
    expect(routeShape("/api/v1/admin/requests/MX-7K3Q9P/status")).toBe("/api/v1/admin/requests/:id/status");
    expect(routeShape("/api/v1/r/aZ3kLm9Qp2Rt7Vw1Xy4Bc6Dn8Fg0Hj5Ks")).toBe("/api/v1/r/:id");
    expect(routeShape("/api/v1/admin/operations/failed-messages")).toBe("/api/v1/admin/operations/failed-messages");
    const ctx = { source: "api" as const, event: "api.unhandled_error", where: "GET /x" };
    expect(errorFingerprint(ctx, "TypeError", "bad 65f1a2b3c4d5e6f7a8b9c0d1 at 12")).toBe(errorFingerprint(ctx, "TypeError", "bad 65f1a2b3c4d5e6f7a8b9c0d2 at 99"));
    expect(errorFingerprint(ctx, "TypeError", "bad")).not.toBe(errorFingerprint(ctx, "RangeError", "bad"));
  });
});

describe("retention and monitoring settings", () => {
  it("defaults to 180 days and rejects unsafe values", () => {
    expect(requestRetentionDays({})).toBe(180);
    expect(requestRetentionDays({ REQUEST_RETENTION_DAYS: "90" })).toBe(90);
    for (const bad of ["3", "0", "-1", "abc", "30.5", "99999"]) expect(() => requestRetentionDays({ REQUEST_RETENTION_DAYS: bad })).toThrow();
  });

  it("checks the error alert webhook and SMS settings at startup", () => {
    const base = { ...process.env };
    expect(checkServerConfiguration("web", { ...base, ERROR_ALERT_WEBHOOK_URL: "http://hooks.example.com/x" }).errors.join()).toMatch(/ERROR_ALERT_WEBHOOK_URL must be an https URL/);
    expect(checkServerConfiguration("web", { ...base, ERROR_ALERT_WEBHOOK_URL: "https://hooks.example.com/x" }).errors).toEqual([]);
    expect(checkServerConfiguration("web", { ...base, SMS_PROVIDER: "twilio" }).errors.join()).toMatch(/sms: TWILIO_ACCOUNT_SID/);
  });
});

const TWILIO = {
  SMS_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: `AC${"a1".repeat(16)}`,
  TWILIO_AUTH_TOKEN: "test-auth-token-0123456789",
  TWILIO_MESSAGING_SERVICE_SID: `MG${"b2".repeat(16)}`,
  SMS_OTP_BODY_TEMPLATE: "{code} is your MarutiX verification code. It expires in {minutes} minutes. - MARUTX",
};

describe("SMS fallback configuration", () => {
  it("is off unless SMS_PROVIDER is set", () => {
    expect(getSmsConfig({})).toBeNull();
    expect(getSmsConfig({ SMS_PROVIDER: "none" })).toBeNull();
  });

  it("validates Twilio settings and the DLT template", () => {
    expect(getSmsConfig(TWILIO)).toMatchObject({ provider: "twilio", dailyCap: 500, perPhoneDaily: 3 });
    expect(() => getSmsConfig({ ...TWILIO, SMS_PROVIDER: "msg91" })).toThrow(/SMS_PROVIDER/);
    expect(() => getSmsConfig({ ...TWILIO, TWILIO_ACCOUNT_SID: "AC123" })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => getSmsConfig({ ...TWILIO, TWILIO_AUTH_TOKEN: "" })).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => getSmsConfig({ ...TWILIO, TWILIO_MESSAGING_SERVICE_SID: "" })).toThrow(/TWILIO_MESSAGING_SERVICE_SID .*or TWILIO_FROM/);
    expect(getSmsConfig({ ...TWILIO, TWILIO_MESSAGING_SERVICE_SID: "", TWILIO_FROM: "+15005550006" })?.from).toBe("+15005550006");
    expect(() => getSmsConfig({ ...TWILIO, SMS_OTP_BODY_TEMPLATE: "Your code" })).toThrow(/\{code\}/);
    expect(() => getSmsConfig({ ...TWILIO, OTP_SMS_DAILY_CAP: "0" })).toThrow(/OTP_SMS_DAILY_CAP/);
    expect(renderSmsOtp(TWILIO.SMS_OTP_BODY_TEMPLATE, "482913", 5)).toBe("482913 is your MarutiX verification code. It expires in 5 minutes. - MARUTX");
  });
});

describe("Twilio SMS provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the rendered DLT text with basic auth and returns the message SID", async () => {
    const config = getSmsConfig(TWILIO)!;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: "SM0123", status: "queued" }), { status: 201 }));
    const result = await twilioSmsOtpProvider(config, fetchMock as unknown as typeof fetch).send({ phoneE164: "+919876543210", code: "482913", expiresInMinutes: 5, requestId: "r" });
    expect(result.providerMessageId).toBe("SM0123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.TWILIO_ACCOUNT_SID}/Messages.json`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${TWILIO.TWILIO_ACCOUNT_SID}:${TWILIO.TWILIO_AUTH_TOKEN}`).toString("base64")}`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe("+919876543210");
    expect(form.get("MessagingServiceSid")).toBe(TWILIO.TWILIO_MESSAGING_SERVICE_SID);
    expect(form.get("Body")).toContain("482913 is your MarutiX verification code");
  });

  it("raises a typed error without the code or number in its message", async () => {
    const config = getSmsConfig(TWILIO)!;
    const failing = vi.fn(async () => new Response(JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number: +919876543210" }), { status: 400 }));
    const error = await twilioSmsOtpProvider(config, failing as unknown as typeof fetch)
      .send({ phoneE164: "+919876543210", code: "482913", expiresInMinutes: 5, requestId: "r" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmsApiError);
    expect((error as SmsApiError).providerCode).toBe("21211");
    expect((error as SmsApiError).message).not.toMatch(/9876543210|482913/);
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(twilioSmsOtpProvider(config, offline as unknown as typeof fetch).send({ phoneE164: "+919876543210", code: "1", expiresInMinutes: 5, requestId: "r" })).rejects.toMatchObject({ providerCode: "NETWORK" });
  });
});
