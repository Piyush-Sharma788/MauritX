import "server-only";
import { definedEnv } from "@/lib/config/env-source";
import { z } from "zod";

/**
 * Nearby institution discovery. "none" uses only institutions already in
 * MarutiX; "openstreetmap" also queries OpenStreetMap (Overpass for places,
 * Nominatim for geocoding). Their usage policies require an identifying
 * contact and light use, so DISCOVERY_CONTACT_EMAIL is required.
 */
const schema = z
  .object({
    DISCOVERY_PROVIDER: z.enum(["none", "openstreetmap"]).default("none"),
    DISCOVERY_CONTACT_EMAIL: z.email().optional(),
    OVERPASS_URL: z.url().default("https://overpass-api.de/api/interpreter"),
    NOMINATIM_URL: z.url().default("https://nominatim.openstreetmap.org"),
    DISCOVERY_WEBSITE_ENRICHMENT: z.enum(["true", "false"]).default("true"),
    // Discovery runs in the background, and public Overpass instances can take 30 s or more under load.
    DISCOVERY_TIMEOUT_MS: z.coerce.number().int().min(2000).max(120_000).default(60_000),
  })
  .superRefine((env, ctx) => {
    if (env.DISCOVERY_PROVIDER === "openstreetmap" && !env.DISCOVERY_CONTACT_EMAIL) {
      ctx.addIssue({ code: "custom", path: ["DISCOVERY_CONTACT_EMAIL"], message: "DISCOVERY_PROVIDER=openstreetmap requires DISCOVERY_CONTACT_EMAIL (OpenStreetMap usage policy)" });
    }
  });

export interface DiscoveryConfig {
  provider: "none" | "openstreetmap";
  contactEmail: string | null;
  overpassUrl: string;
  nominatimUrl: string;
  websiteEnrichment: boolean;
  timeoutMs: number;
  userAgent: string;
}

let cached: DiscoveryConfig | undefined;

export function getDiscoveryConfig(): DiscoveryConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(definedEnv());
  if (!parsed.success) {
    throw new Error(`Invalid discovery configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const env = parsed.data;
  cached = {
    provider: env.DISCOVERY_PROVIDER,
    contactEmail: env.DISCOVERY_CONTACT_EMAIL ?? null,
    overpassUrl: env.OVERPASS_URL,
    nominatimUrl: env.NOMINATIM_URL.replace(/\/$/, ""),
    websiteEnrichment: env.DISCOVERY_WEBSITE_ENRICHMENT === "true",
    timeoutMs: env.DISCOVERY_TIMEOUT_MS,
    userAgent: `MarutiX-EmergencyCoordination/1.0 (${env.DISCOVERY_CONTACT_EMAIL ?? "contact not configured"})`,
  };
  return cached;
}

export function resetDiscoveryConfigForTests() {
  cached = undefined;
}
