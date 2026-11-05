import "server-only";
import { renderSmsOtp, type SmsConfig } from "@/lib/sms/config";
import type { OtpDeliveryProvider } from "@/server/otp-delivery";

const TIMEOUT_MS = 10_000;

export class SmsApiError extends Error {
  override name = "SmsApiError";
  constructor(
    readonly httpStatus: number | null,
    readonly providerCode: string | null,
  ) {
    super(`SMS provider rejected the message (HTTP ${httpStatus ?? "none"}, code ${providerCode ?? "none"})`);
  }
}

/** Twilio Programmable Messaging: POST /2010-04-01/Accounts/{sid}/Messages.json. The code is only ever in the request body. */
export function twilioSmsOtpProvider(config: SmsConfig, fetchImpl: typeof fetch = fetch): OtpDeliveryProvider {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const auth = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`;
  return {
    channel: "sms",
    async send({ phoneE164, code, expiresInMinutes }) {
      const form = new URLSearchParams({ To: phoneE164, Body: renderSmsOtp(config.bodyTemplate, code, expiresInMinutes) });
      if (config.messagingServiceSid) form.set("MessagingServiceSid", config.messagingServiceSid);
      else form.set("From", config.from!);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new SmsApiError(null, "NETWORK");
      }
      const payload = (await response.json().catch(() => null)) as { sid?: string; code?: number | string } | null;
      if (!response.ok || !payload?.sid) throw new SmsApiError(response.status, payload?.code != null ? String(payload.code) : null);
      return { providerMessageId: payload.sid };
    },
  };
}
