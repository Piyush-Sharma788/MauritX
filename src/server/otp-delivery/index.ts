import "server-only";
import type { OtpDeliveryChannel } from "@/features/auth/schemas";
import { getEnv } from "@/lib/env";
import { getSmsConfig } from "@/lib/sms/config";
import { twilioSmsOtpProvider } from "@/server/otp-delivery/sms";
import { maskPhone } from "@/lib/validation/phone";
import { logger } from "@/lib/logger";
import { sendTemplateMessage } from "@/lib/whatsapp/client";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { queueSignInCode } from "@/server/messaging/queue";
import { readConnectionStatus } from "@/server/whatsapp/connection-store";

export interface OtpDeliveryInput {
  phoneE164: string;
  code: string;
  expiresInMinutes: number;
  requestId: string;
}

export interface OtpDeliveryProvider {
  channel: OtpDeliveryChannel;
  /** `channel` is set when the code went out another way than this provider's default. */
  send(input: OtpDeliveryInput): Promise<{ providerMessageId?: string; channel?: OtpDeliveryChannel }>;
}

/**
 * Sends the code with an approved WhatsApp *authentication* template that has
 * a copy-code button. The code must be passed to both the body and the button.
 */
export interface WhatsAppOtpConfig {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  templateName: string;
  languageCode: string;
}

function otpConfigFromEnv(): WhatsAppOtpConfig {
  const env = getEnv();
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN!,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
    templateName: env.WHATSAPP_OTP_TEMPLATE_NAME!,
    languageCode: env.WHATSAPP_OTP_TEMPLATE_LANGUAGE,
  };
}

export function whatsAppOtpProvider(config: WhatsAppOtpConfig = otpConfigFromEnv()): OtpDeliveryProvider {
  return {
    channel: "whatsapp",
    async send({ phoneE164, code }) {
      const result = await sendTemplateMessage(config, {
        to: phoneE164,
        templateName: config.templateName,
        languageCode: config.languageCode,
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      });
      return { providerMessageId: result.messageId };
    },
  };
}

/**
 * DEVELOPMENT ONLY. Nothing is sent to the user. The code is printed to the
 * server terminal, and the API reports `channel: "development"` so the UI can
 * say so plainly. Refuses to run in production.
 */
function developmentProvider(): OtpDeliveryProvider {
  return {
    channel: "development",
    async send({ phoneE164, code, expiresInMinutes, requestId }) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Development OTP provider is disabled in production");
      }
      console.warn(
        [
          "",
          "┌──────────────── MarutiX DEVELOPMENT OTP ────────────────┐",
          "│ NOT SENT VIA WHATSAPP. Local development provider only. │",
          `│ To:      ${maskPhone(phoneE164).padEnd(47)}│`,
          `│ Code:    ${code.padEnd(47)}│`,
          `│ Expires: in ${`${expiresInMinutes} minutes`.padEnd(44)}│`,
          `│ Request: ${requestId.slice(0, 8).padEnd(47)}│`,
          "└─────────────────────────────────────────────────────────┘",
          "",
        ].join("\n"),
      );
      return {};
    },
  };
}

export interface SmsOtpOption {
  provider: OtpDeliveryProvider;
  perPhoneDaily: number;
  dailyCap: number;
}

/** The SMS fallback, or null when SMS_PROVIDER isn't configured. */
export function getSmsOtpOption(): SmsOtpOption | null {
  const config = getSmsConfig();
  if (!config) return null;
  return { provider: twilioSmsOtpProvider(config), perPhoneDaily: config.perPhoneDaily, dailyCap: config.dailyCap };
}

/**
 * PILOT ONLY (OTP_PROVIDER=whatsapp_web): sends the code from the phone linked to the
 * WhatsApp Web pilot worker. Refused in production unless OTP_ALLOW_WHATSAPP_WEB_IN_PROD=true.
 *
 * The code goes through the MongoDB outbox, which the worker drains, so the web app never
 * calls the worker directly: they may run on different machines (e.g. Vercel + a local worker).
 * When no worker is connected, development prints the code in the terminal and the sign-in
 * screen says so; production fails, so the OTP service can fall back to SMS if configured.
 */
export function whatsAppWebDevOtpProvider(): OtpDeliveryProvider {
  const fallback = developmentProvider();
  return {
    channel: "whatsapp",
    async send(input) {
      if (process.env.NODE_ENV === "production" && process.env.OTP_ALLOW_WHATSAPP_WEB_IN_PROD !== "true") {
        throw new Error("OTP_PROVIDER=whatsapp_web is disabled in production");
      }
      const status = await readConnectionStatus(getWhatsAppWebConfig());
      if (!status.workerOnline || status.state !== "connected") {
        logger.warn("otp.whatsapp_web_fallback", { requestId: input.requestId, reason: status.workerOnline ? "not_connected" : "unavailable" });
        if (process.env.NODE_ENV === "production") throw new Error("WhatsApp Web sign-in code not sent: worker not connected");
        await fallback.send(input);
        return { channel: "development" };
      }
      const result = await queueSignInCode({ phoneE164: input.phoneE164, code: input.code, minutes: input.expiresInMinutes, requestId: input.requestId });
      if (result.outcome === "suppressed") throw new Error(`WhatsApp Web sign-in code not sent: ${result.reason}`);
      return {};
    },
  };
}

export function getOtpDeliveryProvider(): OtpDeliveryProvider {
  const provider = getEnv().otpProvider;
  if (provider === "whatsapp") return whatsAppOtpProvider();
  if (provider === "whatsapp_web") return whatsAppWebDevOtpProvider();
  return developmentProvider();
}
