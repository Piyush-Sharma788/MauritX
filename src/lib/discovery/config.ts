import "server-only";
import { definedEnv } from "@/lib/config/env-source";
import { z } from "zod";

/**
 * Nearby institution discovery. "none" uses only institutions already in
 * MarutiX; "openstreetmap" also queries OpenStreetMap (Overpass for places,
 * Nominatim for geocoding). Their usage policies require an identifying
 * contact and light use, so DISCOVERY_CONTACT_EMAIL or DISCOVERY_CONTACT_URL
 * is required, and every call is sequential, delayed and capped.
 *
 * Background area discovery (DISCOVERY_AREA_REFRESH) finds and refreshes
 * hospitals and blood banks around every area where MarutiX has donors or
 * requests. Areas come from the database; nothing is hardcoded.
 */
const bool = z.enum(["true", "false"]);
const schema = z
  .object({
    DISCOVERY_PROVIDER: z.enum(["none", "openstreetmap"]).default("none"),
    DISCOVERY_CONTACT_EMAIL: z.email().optional(),
    DISCOVERY_CONTACT_URL: z.url({ protocol: /^https?$/ }).optional(),
    OVERPASS_URL: z.url().default("https://overpass-api.de/api/interpreter"),
    NOMINATIM_URL: z.url().default("https://nominatim.openstreetmap.org"),
    DISCOVERY_WEBSITE_ENRICHMENT: bool.default("true"),
    // Discovery runs in the background, and public Overpass instances can take 30 s or more under load.
    DISCOVERY_TIMEOUT_MS: z.coerce.number().int().min(2000).max(120_000).default(60_000),
    DISCOVERY_WEBSITE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    // Website enrichment per run (per request or per area), and how often one site is re-read.
    DISCOVERY_ENRICH_PER_RUN: z.coerce.number().int().min(0).max(50).default(6),
    DISCOVERY_ENRICH_AGAIN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    // Scheduled area discovery and refresh.
    DISCOVERY_AREA_REFRESH: bool.default("true"),
    DISCOVERY_REFRESH_DAYS: z.coerce.number().min(1).max(365).default(14),
    DISCOVERY_AREA_RADIUS_KM: z.coerce.number().min(2).max(50).default(10),
    DISCOVERY_AREAS_PER_RUN: z.coerce.number().int().min(1).max(50).default(3),
    DISCOVERY_MAX_AREAS: z.coerce.number().int().min(1).max(2000).default(200),
    DISCOVERY_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(60),
    // Pause between two calls to the same external service (OSM asks for light use).
    DISCOVERY_REQUEST_DELAY_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    // How long to back off an area (and the whole sweep) after a 429/504 from the source.
    DISCOVERY_BACKOFF_MINUTES: z.coerce.number().int().min(1).max(7 * 24 * 60).default(60),
    // Contact validation: email domain DNS (MX, then A/AAAA) and website reachability.
    DISCOVERY_VALIDATE_CONTACTS: bool.default("true"),
    // Website reachability (one small GET per site) during area refresh.
    DISCOVERY_VALIDATE_WEBSITES: bool.default("true"),
    DISCOVERY_DNS_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(3000),
    DISCOVERY_VALIDATE_PER_RUN: z.coerce.number().int().min(0).max(500).default(40),
    // AI-assisted extraction from website text (whenever AI_PROVIDER is gemini, openai or anthropic).
    DISCOVERY_AI_EXTRACTION: bool.default("true"),
    DISCOVERY_AI_MAX_INPUT_CHARS: z.coerce.number().int().min(500).max(30_000).default(6000),
    DISCOVERY_AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
    // Blood stock availability. India's e-RaktKosh has no public API and is not scraped.
    BLOOD_AVAILABILITY_PROVIDER: z.enum(["none"]).default("none"),
  })
  .superRefine((env, ctx) => {
    if (env.DISCOVERY_PROVIDER === "openstreetmap" && !env.DISCOVERY_CONTACT_EMAIL && !env.DISCOVERY_CONTACT_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["DISCOVERY_CONTACT_EMAIL"],
        message: "DISCOVERY_PROVIDER=openstreetmap requires DISCOVERY_CONTACT_EMAIL or DISCOVERY_CONTACT_URL (OpenStreetMap usage policy)",
      });
    }
  });

export interface DiscoveryConfig {
  provider: "none" | "openstreetmap";
  contactEmail: string | null;
  contactUrl: string | null;
  overpassUrl: string;
  nominatimUrl: string;
  websiteEnrichment: boolean;
  timeoutMs: number;
  websiteTimeoutMs: number;
  userAgent: string;
  enrichPerRun: number;
  enrichAgainMs: number;
  areaRefresh: boolean;
  refreshMs: number;
  areaRadiusKm: number;
  areasPerRun: number;
  maxAreas: number;
  sweepIntervalMs: number;
  requestDelayMs: number;
  backoffMs: number;
  validateContacts: boolean;
  validateWebsites: boolean;
  dnsTimeoutMs: number;
  validatePerRun: number;
  aiExtraction: boolean;
  aiMaxInputChars: number;
  aiMinConfidence: number;
  availabilityProvider: "none";
}

let cached: DiscoveryConfig | undefined;

export function getDiscoveryConfig(): DiscoveryConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
  if (!parsed.success) {
    throw new Error(`Invalid discovery configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const env = parsed.data;
  const contact = [env.DISCOVERY_CONTACT_URL ? `+${env.DISCOVERY_CONTACT_URL}` : null, env.DISCOVERY_CONTACT_EMAIL ?? null].filter(Boolean).join("; ");
  const DAY = 24 * 60 * 60_000;
  cached = {
    provider: env.DISCOVERY_PROVIDER,
    contactEmail: env.DISCOVERY_CONTACT_EMAIL ?? null,
    contactUrl: env.DISCOVERY_CONTACT_URL ?? null,
    overpassUrl: env.OVERPASS_URL,
    nominatimUrl: env.NOMINATIM_URL.replace(/\/$/, ""),
    websiteEnrichment: env.DISCOVERY_WEBSITE_ENRICHMENT === "true",
    timeoutMs: env.DISCOVERY_TIMEOUT_MS,
    websiteTimeoutMs: env.DISCOVERY_WEBSITE_TIMEOUT_MS,
    userAgent: `MarutiX-EmergencyCoordination/1.0 (${contact || "contact not configured"})`,
    enrichPerRun: env.DISCOVERY_ENRICH_PER_RUN,
    enrichAgainMs: env.DISCOVERY_ENRICH_AGAIN_DAYS * DAY,
    areaRefresh: env.DISCOVERY_AREA_REFRESH === "true",
    refreshMs: env.DISCOVERY_REFRESH_DAYS * DAY,
    areaRadiusKm: env.DISCOVERY_AREA_RADIUS_KM,
    areasPerRun: env.DISCOVERY_AREAS_PER_RUN,
    maxAreas: env.DISCOVERY_MAX_AREAS,
    sweepIntervalMs: env.DISCOVERY_SWEEP_INTERVAL_MINUTES * 60_000,
    requestDelayMs: env.DISCOVERY_REQUEST_DELAY_MS,
    backoffMs: env.DISCOVERY_BACKOFF_MINUTES * 60_000,
    validateContacts: env.DISCOVERY_VALIDATE_CONTACTS === "true",
    validateWebsites: env.DISCOVERY_VALIDATE_WEBSITES === "true",
    dnsTimeoutMs: env.DISCOVERY_DNS_TIMEOUT_MS,
    validatePerRun: env.DISCOVERY_VALIDATE_PER_RUN,
    aiExtraction: env.DISCOVERY_AI_EXTRACTION === "true",
    aiMaxInputChars: env.DISCOVERY_AI_MAX_INPUT_CHARS,
    aiMinConfidence: env.DISCOVERY_AI_MIN_CONFIDENCE,
    availabilityProvider: env.BLOOD_AVAILABILITY_PROVIDER,
  };
  return cached;
}

export function resetDiscoveryConfigForTests() {
  cached = undefined;
}
