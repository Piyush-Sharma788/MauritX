import "server-only";
import { z } from "zod";

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    MONGODB_URI: z.string({ error: "MONGODB_URI is required" }).min(1),
    APP_BASE_URL: z.url({ error: "APP_BASE_URL must be a valid URL" }),
    AUTH_JWT_SECRET: secret("AUTH_JWT_SECRET"),
    OTP_HASH_SECRET: secret("OTP_HASH_SECRET"),
    PII_ENCRYPTION_KEY: z
      .string({ error: "PII_ENCRYPTION_KEY is required" })
      .refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "PII_ENCRYPTION_KEY must be 32 bytes encoded as base64",
      }),
    OTP_PROVIDER: z.enum(["whatsapp", "development"]).optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_OTP_TEMPLATE_NAME: z.string().optional(),
    WHATSAPP_OTP_TEMPLATE_LANGUAGE: z.string().default("en"),
    WHATSAPP_GRAPH_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, "WHATSAPP_GRAPH_API_VERSION must look like v26.0")
      .default("v26.0"),
  })
  .transform((env) => {
    const hasWhatsApp = Boolean(
      env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_OTP_TEMPLATE_NAME,
    );
    // Default to WhatsApp whenever it is configured; fall back to the
    // development provider only outside production.
    const otpProvider =
      env.OTP_PROVIDER ?? (hasWhatsApp || env.NODE_ENV === "production" ? "whatsapp" : "development");
    return { ...env, otpProvider, hasWhatsApp };
  })
  .superRefine((env, ctx) => {
    if (env.otpProvider === "development" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["OTP_PROVIDER"],
        message: "The development OTP provider can never be used in production",
      });
    }
    if (env.otpProvider === "whatsapp" && !env.hasWhatsApp) {
      ctx.addIssue({
        code: "custom",
        path: ["OTP_PROVIDER"],
        message:
          "OTP_PROVIDER=whatsapp requires WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_OTP_TEMPLATE_NAME",
      });
    }
  });

export type ServerEnv = z.output<typeof envSchema>;

let cached: ServerEnv | undefined;

/** Validated server environment. Throws a descriptive error on misconfiguration. */
export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid server environment configuration:\n${issues.join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";
