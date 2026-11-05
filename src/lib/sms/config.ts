/**
 * SMS fallback for sign-in codes (SMS_PROVIDER). Off unless configured.
 *
 * India: every SMS must come from a DLT-registered sender ID and match a
 * DLT-registered content template exactly, or operators drop it. Register
 * the sender and template (through Twilio, for SMS_PROVIDER=twilio) before
 * enabling this, and set SMS_OTP_BODY_TEMPLATE to the registered text with
 * {code} and {minutes} where the variables go.
 */
export interface SmsConfig {
  provider: "twilio";
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  from?: string;
  bodyTemplate: string;
  /** All SMS codes across the service per UTC day: caps cost if the endpoint is abused. */
  dailyCap: number;
  /** SMS codes per number per day. */
  perPhoneDaily: number;
}

const int = (raw: string | undefined, fallback: number, name: string, max: number) => {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be a whole number from 1 to ${max}`);
  return n;
};

export function getSmsConfig(env: Record<string, string | undefined> = process.env): SmsConfig | null {
  const provider = env.SMS_PROVIDER?.trim() || "none";
  if (provider === "none") return null;
  if (provider !== "twilio") throw new Error(`SMS_PROVIDER must be "twilio" or "none", got "${provider}"`);

  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim() || undefined;
  const from = env.TWILIO_FROM?.trim() || undefined;
  const bodyTemplate = env.SMS_OTP_BODY_TEMPLATE?.trim() ?? "";

  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new Error("TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters");
  if (authToken.length < 16) throw new Error("TWILIO_AUTH_TOKEN is required");
  if (!messagingServiceSid && !from) throw new Error("Set TWILIO_MESSAGING_SERVICE_SID (recommended) or TWILIO_FROM");
  if (messagingServiceSid && !/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) throw new Error("TWILIO_MESSAGING_SERVICE_SID must look like MG followed by 32 hex characters");
  if (!bodyTemplate.includes("{code}")) throw new Error("SMS_OTP_BODY_TEMPLATE must contain {code} (the DLT-registered text)");
  if (bodyTemplate.length > 300) throw new Error("SMS_OTP_BODY_TEMPLATE is too long for a one-time-code SMS");

  return {
    provider: "twilio",
    accountSid,
    authToken,
    messagingServiceSid,
    from,
    bodyTemplate,
    dailyCap: int(env.OTP_SMS_DAILY_CAP, 500, "OTP_SMS_DAILY_CAP", 1_000_000),
    perPhoneDaily: int(env.OTP_SMS_PER_PHONE_DAILY, 3, "OTP_SMS_PER_PHONE_DAILY", 20),
  };
}

export function renderSmsOtp(template: string, code: string, minutes: number): string {
  return template.replaceAll("{code}", code).replaceAll("{minutes}", String(minutes));
}
