import "server-only";
import { definedEnv } from "@/lib/config/env-source";
import { z } from "zod";

/**
 * Official WhatsApp Business Platform (Cloud API) configuration, shared by
 * sign-in codes and messaging. MESSAGING_PROVIDER chooses which provider
 * drains the outbox; it stays "whatsapp_web" until the Cloud API is tested.
 */
const schema = z
  .object({
    MESSAGING_PROVIDER: z.enum(["whatsapp_web", "whatsapp_cloud"]).default("whatsapp_web"),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d{5,20}$/, "WHATSAPP_PHONE_NUMBER_ID must be the numeric phone number ID").optional(),
    WHATSAPP_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),
    // Signs webhook payloads (Meta App Dashboard → App settings → Basic → App secret).
    WHATSAPP_APP_SECRET: z.string().min(16, "WHATSAPP_APP_SECRET looks too short").optional(),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(16, "WHATSAPP_WEBHOOK_VERIFY_TOKEN must be at least 16 characters").optional(),
    // Approved templates for business-initiated messages (outside the 24-hour window).
    WHATSAPP_TEMPLATE_EMERGENCY_ALERT: z.string().regex(/^[a-z0-9_]{1,512}$/).optional(),
    WHATSAPP_TEMPLATE_REQUEST_CONFIRMATION: z.string().regex(/^[a-z0-9_]{1,512}$/).optional(),
    WHATSAPP_TEMPLATE_LANGUAGE: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default("en"),
    // Outbox pacing for the official API (well under Meta's per-number throughput).
    WHATSAPP_CLOUD_MAX_MESSAGES_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(250),
    WHATSAPP_CLOUD_MAX_REPLIES_PER_HOUR: z.coerce.number().int().min(1).max(20_000).default(1000),
    WHATSAPP_CLOUD_MIN_SEND_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(250),
  })
  .superRefine((env, ctx) => {
    if (env.MESSAGING_PROVIDER !== "whatsapp_cloud") return;
    for (const key of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"] as const) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: `MESSAGING_PROVIDER=whatsapp_cloud requires ${key}` });
    }
  });

export type MessagingProviderName = "whatsapp_web" | "whatsapp_cloud";

export interface WhatsAppCloudConfig {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  appSecret: string | null;
  verifyToken: string | null;
  templates: { emergencyAlert: string | null; requestConfirmation: string | null; language: string };
  pacing: { maxMessagesPerHour: number; maxRepliesPerHour: number; minSendIntervalMs: number };
}

let cached: { provider: MessagingProviderName; cloud: WhatsAppCloudConfig | null } | undefined;

function load() {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
  if (!parsed.success) {
    throw new Error(`Invalid WhatsApp Cloud API configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const env = parsed.data;
  cached = {
    provider: env.MESSAGING_PROVIDER,
    cloud:
      env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
        ? {
            accessToken: env.WHATSAPP_ACCESS_TOKEN,
            phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
            graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
            appSecret: env.WHATSAPP_APP_SECRET ?? null,
            verifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? null,
            templates: {
              emergencyAlert: env.WHATSAPP_TEMPLATE_EMERGENCY_ALERT ?? null,
              requestConfirmation: env.WHATSAPP_TEMPLATE_REQUEST_CONFIRMATION ?? null,
              language: env.WHATSAPP_TEMPLATE_LANGUAGE,
            },
            pacing: {
              maxMessagesPerHour: env.WHATSAPP_CLOUD_MAX_MESSAGES_PER_HOUR,
              maxRepliesPerHour: env.WHATSAPP_CLOUD_MAX_REPLIES_PER_HOUR,
              minSendIntervalMs: env.WHATSAPP_CLOUD_MIN_SEND_INTERVAL_MS,
            },
          }
        : null,
  };
  return cached;
}

/** Which provider drains the outbox. */
export const getMessagingProviderName = (): MessagingProviderName => load().provider;

/** Cloud API settings, or null when the access token or phone number ID is missing. */
export const getWhatsAppCloudConfig = (): WhatsAppCloudConfig | null => load().cloud;

export function resetWhatsAppCloudConfigForTests() {
  cached = undefined;
}
