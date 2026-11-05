import "server-only";
import { definedEnv } from "@/lib/config/env-source";
import { z } from "zod";

/** Institutional outreach email. "none" means no email is sent and outreach says so. */
const schema = z
  .object({
    EMAIL_PROVIDER: z.enum(["none", "smtp"]).default("none"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.enum(["true", "false"]).default("false"),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    EMAIL_REPLY_TO: z.email().optional(),
    EMAIL_MAX_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(60),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === "smtp") {
      for (const key of ["SMTP_HOST", "EMAIL_FROM"] as const) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: `EMAIL_PROVIDER=smtp requires ${key}` });
      }
    }
  });

export interface EmailConfig {
  provider: "none" | "smtp";
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
  replyTo?: string;
  maxPerHour: number;
}

let cached: EmailConfig | undefined;

export function getEmailConfig(): EmailConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
  if (!parsed.success) {
    throw new Error(`Invalid email configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const env = parsed.data;
  cached = {
    provider: env.EMAIL_PROVIDER,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE === "true",
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    maxPerHour: env.EMAIL_MAX_PER_HOUR,
  };
  return cached;
}

export function resetEmailConfigForTests() {
  cached = undefined;
}
