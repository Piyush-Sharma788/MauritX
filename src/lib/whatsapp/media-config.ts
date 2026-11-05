import "server-only";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { MediaKey } from "@/features/whatsapp/types";
import { definedEnv } from "@/lib/config/env-source";

/**
 * Images the bot may send, shared by both providers. Messages refer to an
 * image only by key ("welcome"); the file and URL come from here, never from
 * user input.
 *
 * - WHATSAPP_WELCOME_IMAGE_ENABLED: send the welcome image on a number's first message.
 * - WHATSAPP_WELCOME_IMAGE_PATH: the PNG/JPEG, relative to the app's working directory or absolute.
 * - WHATSAPP_WELCOME_IMAGE_URL: optional public https copy; the Cloud API then sends the link
 *   instead of uploading the file.
 * - WHATSAPP_CLOUD_MEDIA_CACHE_HOURS: how long an uploaded Cloud API media ID is reused
 *   (Meta keeps uploads for 30 days).
 */
const schema = z.object({
  WHATSAPP_WELCOME_IMAGE_ENABLED: z.enum(["true", "false"]).default("true"),
  WHATSAPP_WELCOME_IMAGE_PATH: z
    .string()
    .min(1)
    .regex(/\.(png|jpe?g)$/i, "WHATSAPP_WELCOME_IMAGE_PATH must be a .png, .jpg or .jpeg file")
    .default("public/whatsapp/welcome.png"),
  WHATSAPP_WELCOME_IMAGE_URL: z.url({ protocol: /^https$/, error: "WHATSAPP_WELCOME_IMAGE_URL must be an https URL" }).optional(),
  WHATSAPP_CLOUD_MEDIA_CACHE_HOURS: z.coerce.number().int().min(1).max(29 * 24).default(7 * 24),
});

/** WhatsApp's limit for images is 5 MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface MediaAsset {
  key: MediaKey;
  /** Absolute path of the file. */
  filePath: string;
  mimeType: "image/png" | "image/jpeg";
  /** A public https copy, if configured (Cloud API may send the link instead of uploading). */
  publicUrl: string | null;
}

export interface WhatsAppMediaConfig {
  welcomeImageEnabled: boolean;
  welcomeImagePath: string;
  welcomeImageUrl: string | null;
  cloudMediaCacheMs: number;
}

let cached: WhatsAppMediaConfig | undefined;

export function getWhatsAppMediaConfig(): WhatsAppMediaConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
  if (!parsed.success) {
    throw new Error(`Invalid WhatsApp media configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const env = parsed.data;
  cached = {
    welcomeImageEnabled: env.WHATSAPP_WELCOME_IMAGE_ENABLED === "true",
    // path.resolve() resolves a relative path against the working directory at run time. Not
    // written as path.resolve(process.cwd(), …): that makes Turbopack trace the whole project
    // into the server bundle ("Dynamic filesystem access" build warning).
    welcomeImagePath: path.resolve(env.WHATSAPP_WELCOME_IMAGE_PATH),
    welcomeImageUrl: env.WHATSAPP_WELCOME_IMAGE_URL ?? null,
    cloudMediaCacheMs: env.WHATSAPP_CLOUD_MEDIA_CACHE_HOURS * 60 * 60 * 1000,
  };
  return cached;
}

/** Whether new first contacts should get the welcome image. */
export const welcomeImageEnabled = () => getWhatsAppMediaConfig().welcomeImageEnabled;

/**
 * The asset for a key, or null when it's switched off or the file is missing,
 * unreadable or too large. Callers then send the caption as plain text.
 */
export function resolveMediaAsset(key: MediaKey): MediaAsset | null {
  const config = getWhatsAppMediaConfig();
  if (key !== "welcome" || !config.welcomeImageEnabled) return null;
  const filePath = config.welcomeImagePath;
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return null;
  } catch {
    return null;
  }
  return { key, filePath, mimeType: /\.png$/i.test(filePath) ? "image/png" : "image/jpeg", publicUrl: config.welcomeImageUrl };
}

export function resetWhatsAppMediaConfigForTests() {
  cached = undefined;
}
