import "server-only";
import { definedEnv } from "@/lib/config/env-source";
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
  // Phase 6: automated coordination after an admin activates a request.
  COORDINATION_AUTOSTART: z.enum(["true", "false"]).default("true"),
  DONOR_ZONES_KM: z
    .string()
    .default("5,10,25,50")
    .transform((v) => v.split(",").map((x) => Number(x.trim())))
    .refine((zones) => zones.length >= 1 && zones.length <= 6 && zones.every((z, i) => Number.isFinite(z) && z > 0 && z <= 100 && (i === 0 || z > zones[i - 1])), "DONOR_ZONES_KM must be 1–6 increasing distances up to 100 km"),
  DONOR_WAVE_SIZE: z.coerce.number().int().min(1).max(20).default(5),
  DONOR_WAVE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(20),
  // Stop expanding once this many donors are interested; 0 means twice the units requested.
  DONOR_TARGET_INTERESTED: z.coerce.number().int().min(0).max(50).default(0),
  OUTREACH_RADIUS_KM: z.coerce.number().min(1).max(100).default(25),
  OUTREACH_MAX_INSTITUTIONS: z.coerce.number().int().min(1).max(50).default(10),
  OUTREACH_INCLUDE_UNREVIEWED: z.enum(["true", "false"]).default("false"),
  OUTREACH_MAX_PER_INSTITUTION_PER_DAY: z.coerce.number().int().min(1).max(20).default(5),
  COORDINATOR_CONTACT_PHONE: z.string().trim().regex(/^\+?[0-9][0-9 -]{5,18}[0-9]$/).optional(),
  COORDINATOR_CONTACT_EMAIL: z.email().optional(),
});

export interface CoordinationConfig {
  alertBatchSize: number;
  alertMaxPerRequest: number;
  alertMaxPerDonorPerDay: number;
  alertTtlMs: number;
  minDonationIntervalDays: number;
  maxCandidates: number;
  autostart: boolean;
  zonesKm: number[];
  waveSize: number;
  waveIntervalMs: number;
  targetInterested: number;
  outreachRadiusKm: number;
  outreachMaxInstitutions: number;
  outreachIncludeUnreviewed: boolean;
  outreachMaxPerInstitutionPerDay: number;
  coordinatorPhone: string | null;
  coordinatorEmail: string | null;
}

let cached: CoordinationConfig | undefined;

export function getCoordinationConfig(): CoordinationConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
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
    autostart: env.COORDINATION_AUTOSTART === "true",
    zonesKm: env.DONOR_ZONES_KM,
    waveSize: env.DONOR_WAVE_SIZE,
    waveIntervalMs: env.DONOR_WAVE_INTERVAL_MINUTES * 60_000,
    targetInterested: env.DONOR_TARGET_INTERESTED,
    outreachRadiusKm: env.OUTREACH_RADIUS_KM,
    outreachMaxInstitutions: env.OUTREACH_MAX_INSTITUTIONS,
    outreachIncludeUnreviewed: env.OUTREACH_INCLUDE_UNREVIEWED === "true",
    outreachMaxPerInstitutionPerDay: env.OUTREACH_MAX_PER_INSTITUTION_PER_DAY,
    coordinatorPhone: env.COORDINATOR_CONTACT_PHONE || null,
    coordinatorEmail: env.COORDINATOR_CONTACT_EMAIL || null,
  };
  return cached;
}

export function resetCoordinationConfigForTests() {
  cached = undefined;
}
