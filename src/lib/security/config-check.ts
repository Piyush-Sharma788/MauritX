import "server-only";
import { getAiConfig } from "@/lib/ai/config";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { getDiscoveryConfig } from "@/lib/discovery/config";
import { getEmailConfig } from "@/lib/email/config";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getMessagingProviderName, getWhatsAppCloudConfig } from "@/lib/whatsapp/cloud-config";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";

/**
 * Startup validation of every secret and integration setting. Each process
 * calls it before doing any work, so a misconfiguration stops it at boot
 * instead of failing on the first request. Production adds stricter rules.
 */

export type ProcessRole = "web" | "whatsapp-worker" | "jobs-worker";

const PLACEHOLDER = /(change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_](secret|key|token)|example[-_]?(secret|key|token)|password)/i;

/** A secret that is long but obviously not random (placeholder words, few distinct characters). */
export function weakSecret(value: string): string | null {
  if (PLACEHOLDER.test(value)) return "looks like a placeholder";
  if (new Set(value).size < 12) return "has too few distinct characters to be random";
  return null;
}

export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS ?? "1";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error("TRUSTED_PROXY_HOPS must be a whole number from 0 to 5");
  return n;
}

export interface ConfigReport {
  errors: string[];
  warnings: string[];
}

/** Collects problems without throwing, so tests and tooling can inspect them. */
export function checkServerConfiguration(role: ProcessRole, environment: Record<string, string | undefined> = process.env): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = environment.NODE_ENV === "production";
  const attempt = (label: string, fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  attempt("core", getEnv);
  attempt("coordination", getCoordinationConfig);
  attempt("discovery", getDiscoveryConfig);
  attempt("email", getEmailConfig);
  attempt("ai", getAiConfig);
  attempt("whatsapp cloud", getMessagingProviderName);
  attempt("proxy", trustedProxyHops);
  if (role === "whatsapp-worker") attempt("whatsapp web", getWhatsAppWebConfig);
  if (errors.length) return { errors, warnings };

  const env = getEnv();
  const secrets: [string, string | undefined][] = [
    ["AUTH_JWT_SECRET", env.AUTH_JWT_SECRET],
    ["OTP_HASH_SECRET", env.OTP_HASH_SECRET],
    ["WHATSAPP_WEB_WORKER_SECRET", environment.WHATSAPP_WEB_WORKER_SECRET],
    ["WHATSAPP_APP_SECRET", environment.WHATSAPP_APP_SECRET],
    ["WHATSAPP_WEBHOOK_VERIFY_TOKEN", environment.WHATSAPP_WEBHOOK_VERIFY_TOKEN],
  ];
  const problems: string[] = [];
  for (const [name, value] of secrets) {
    if (!value) continue;
    const weak = weakSecret(value);
    if (weak) problems.push(`${name} ${weak}`);
  }
  const present = secrets.filter(([, v]) => v);
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      if (present[i][1] === present[j][1]) problems.push(`${present[i][0]} and ${present[j][0]} must be different secrets`);
    }
  }
  const key = Buffer.from(env.PII_ENCRYPTION_KEY, "base64");
  if (new Set(key).size < 16) problems.push("PII_ENCRYPTION_KEY isn't random (generate it with: openssl rand -base64 32)");

  if (production) {
    errors.push(...problems);
    if (new URL(env.APP_BASE_URL).protocol !== "https:") errors.push("APP_BASE_URL must use https in production");
    if (getMessagingProviderName() === "whatsapp_cloud" && !getWhatsAppCloudConfig()?.appSecret) errors.push("WHATSAPP_APP_SECRET is required to verify webhooks");
    if (environment.TRUSTED_PROXY_HOPS === undefined) warnings.push("TRUSTED_PROXY_HOPS is not set; assuming exactly one reverse proxy in front of the app");
    if (getMessagingProviderName() === "whatsapp_web") warnings.push("Messaging uses the unofficial whatsapp-web.js pilot (MESSAGING_PROVIDER=whatsapp_web)");
  } else {
    warnings.push(...problems);
  }
  return { errors, warnings };
}

/** Throws with every problem listed if this process isn't safe to start. */
export function validateServerConfiguration(role: ProcessRole): void {
  const { errors, warnings } = checkServerConfiguration(role);
  for (const warning of warnings) logger.warn("config.warning", { role, warning });
  if (errors.length) throw new Error(`MarutiX ${role} refused to start. Fix these settings:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  logger.info("config.validated", { role, production: process.env.NODE_ENV === "production" });
}
