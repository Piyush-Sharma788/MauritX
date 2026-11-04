import "server-only";
import { z } from "zod";

/**
 * Emergency alert and matching limits. Conservative defaults: alerts go out
 * in small, admin-triggered batches, and no donor gets more than a couple a day.
 */
const schema = z.object({
  ALERT_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(5),
  ALERT_MAX_PER_REQUEST: z.coerce.number().int().min(1).max(200).default(40),
  ALERT_MAX_PER_DONOR_PER_DAY: z.coerce.number().int().min(1).max(5).default(2),
  ALERT_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
  MATCH_MIN_DONATION_INTERVAL_DAYS: z.coerce.number().int().min(0).max(365).default(90),
  MATCH_MAX_CANDIDATES: z.coerce.number().int().min(10).max(500).default(100),
});

export interface CoordinationConfig {
  alertBatchSize: number;
  alertMaxPerRequest: number;
  alertMaxPerDonorPerDay: number;
  alertTtlMs: number;
  minDonationIntervalDays: number;
  maxCandidates: number;
}

let cached: CoordinationConfig | undefined;

export function getCoordinationConfig(): CoordinationConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid coordination configuration:\n${issues.join("\n")}`);
  }
  const env = parsed.data;
  cached = {
    alertBatchSize: env.ALERT_BATCH_SIZE,
    alertMaxPerRequest: env.ALERT_MAX_PER_REQUEST,
    alertMaxPerDonorPerDay: env.ALERT_MAX_PER_DONOR_PER_DAY,
    alertTtlMs: env.ALERT_TTL_MINUTES * 60_000,
    minDonationIntervalDays: env.MATCH_MIN_DONATION_INTERVAL_DAYS,
    maxCandidates: env.MATCH_MAX_CANDIDATES,
  };
  return cached;
}

export function resetCoordinationConfigForTests() {
  cached = undefined;
}
