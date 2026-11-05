import "server-only";
import { definedEnv } from "@/lib/config/env-source";
import { z } from "zod";
import { normalizeIndianMobile } from "@/lib/validation/phone";

/**
 * Configuration for the whatsapp-web.js pilot. Kept separate from the core
 * env so the rest of the app runs without any of it configured.
 */
const schema = z.object({
  WHATSAPP_WEB_WORKER_URL: z.url().default("http://127.0.0.1:3100"),
  WHATSAPP_WEB_WORKER_SECRET: z
    .string({ error: "WHATSAPP_WEB_WORKER_SECRET is required for the WhatsApp Web pilot" })
    .min(32, "WHATSAPP_WEB_WORKER_SECRET must be at least 32 characters"),
  WHATSAPP_WEB_SESSION_DIR: z.string().min(1).default(".data/whatsapp-session"),
  WHATSAPP_WEB_DEVICE_NAME: z.string().min(1).max(40).default("MarutiX Pilot"),
  WHATSAPP_WEB_TEST_RECIPIENTS: z.string().default(""),
  WHATSAPP_WEB_MAX_MESSAGES_PER_HOUR: z.coerce.number().int().min(1).max(200).default(30),
  WHATSAPP_WEB_MAX_REPLIES_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(300),
  WHATSAPP_WEB_MIN_SEND_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(4000),
  WHATSAPP_WEB_MESSAGE_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
  WHATSAPP_WEB_NO_SANDBOX: z.enum(["true", "false"]).default("false"),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
});

export interface WhatsAppWebConfig {
  workerUrl: URL;
  workerSecret: string;
  /** As configured; the worker resolves and validates it (see session-dir.ts). */
  sessionDir: string;
  deviceName: string;
  testRecipients: Set<string>;
  maxMessagesPerHour: number;
  maxRepliesPerHour: number;
  minSendIntervalMs: number;
  messageTtlMs: number;
  noSandbox: boolean;
  executablePath?: string;
}

let cached: WhatsAppWebConfig | undefined;

export function getWhatsAppWebConfig(): WhatsAppWebConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid WhatsApp Web configuration:\n${issues.join("\n")}`);
  }
  const env = parsed.data;

  const testRecipients = new Set<string>();
  for (const raw of env.WHATSAPP_WEB_TEST_RECIPIENTS.split(",").map((s) => s.trim()).filter(Boolean)) {
    const e164 = normalizeIndianMobile(raw);
    if (!e164) throw new Error("WHATSAPP_WEB_TEST_RECIPIENTS must contain only valid Indian mobile numbers");
    testRecipients.add(e164);
  }

  cached = {
    workerUrl: new URL(env.WHATSAPP_WEB_WORKER_URL),
    workerSecret: env.WHATSAPP_WEB_WORKER_SECRET,
    sessionDir: env.WHATSAPP_WEB_SESSION_DIR,
    deviceName: env.WHATSAPP_WEB_DEVICE_NAME,
    testRecipients,
    maxMessagesPerHour: env.WHATSAPP_WEB_MAX_MESSAGES_PER_HOUR,
    maxRepliesPerHour: env.WHATSAPP_WEB_MAX_REPLIES_PER_HOUR,
    minSendIntervalMs: env.WHATSAPP_WEB_MIN_SEND_INTERVAL_MS,
    messageTtlMs: env.WHATSAPP_WEB_MESSAGE_TTL_MINUTES * 60_000,
    noSandbox: env.WHATSAPP_WEB_NO_SANDBOX === "true",
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
  };
  return cached;
}

/** Test hook: forget cached configuration after changing process.env. */
export function resetWhatsAppWebConfigForTests() {
  cached = undefined;
}
