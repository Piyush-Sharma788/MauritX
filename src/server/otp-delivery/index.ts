import "server-only";
import type { OtpDeliveryChannel } from "@/features/auth/schemas";
import { getEnv } from "@/lib/env";
import { maskPhone } from "@/lib/validation/phone";
import { sendTemplateMessage } from "@/lib/whatsapp/client";

export interface OtpDeliveryInput {
  phoneE164: string;
  code: string;
  expiresInMinutes: number;
  requestId: string;
}

export interface OtpDeliveryProvider {
  channel: OtpDeliveryChannel;
  send(input: OtpDeliveryInput): Promise<{ providerMessageId?: string }>;
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

export function getOtpDeliveryProvider(): OtpDeliveryProvider {
  return getEnv().otpProvider === "whatsapp" ? whatsAppOtpProvider() : developmentProvider();
}
