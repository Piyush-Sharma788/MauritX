import "server-only";
import { AppError } from "@/lib/api/errors";
import { rateLimitKey } from "@/lib/security/crypto";
import { RateLimitBucket } from "@/server/models/rate-limit-bucket";

export interface RateLimitRule {
  /** Stable name, e.g. "otp-send:ip". */
  scope: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  otpSendPerIp: { scope: "otp-send:ip", limit: 10, windowSeconds: 15 * 60 },
  otpSendPerPhone: { scope: "otp-send:phone", limit: 5, windowSeconds: 60 * 60 },
  otpVerifyPerIp: { scope: "otp-verify:ip", limit: 30, windowSeconds: 15 * 60 },
  otpVerifyPerPhone: { scope: "otp-verify:phone", limit: 15, windowSeconds: 60 * 60 },
  // SMS costs money per message and is the usual target of OTP pumping; the per-number
  // and service-wide daily caps come from config (getSmsConfig).
  otpSmsPerIp: { scope: "otp-sms:ip", limit: 5, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>;

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000;
}

/**
 * Fixed-window counter. Increments atomically and throws RATE_LIMITED once
 * the limit for the current window is exceeded.
 */
export async function enforceRateLimit(rule: RateLimitRule, identifier: string, now = new Date()): Promise<void> {
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const windowEnd = new Date(windowStart + windowMs);
  const key = rateLimitKey(`${rule.scope}:${identifier}:${windowStart}`);

  const increment = () =>
    RateLimitBucket.findOneAndUpdate(
      { key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: windowEnd } },
      { upsert: true, returnDocument: "after", lean: true },
    );

  let bucket;
  try {
    bucket = await increment();
  } catch (error) {
    // Two concurrent upserts on a new key: the loser retries as an update.
    if (!isDuplicateKeyError(error)) throw error;
    bucket = await increment();
  }

  if (bucket && bucket.count > rule.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd.getTime() - now.getTime()) / 1000));
    throw new AppError(429, "RATE_LIMITED", "Too many attempts. Please wait a while and try again.", {
      retryAfterSeconds,
    });
  }
}
