import "server-only";
import type { DiscoveryConfig } from "@/lib/discovery/config";
import { dedupeDiscovered, fromOsmElement, type DiscoveredInstitution, type OsmElement } from "@/server/discovery/normalize";
import { haversineKm } from "@/server/matching/engine";
import { ProviderThrottledError, type DiscoveryProvider } from "@/server/discovery/provider";
import { safeFetchText } from "@/server/discovery/safe-fetch";

/**
 * OpenStreetMap: Overpass for nearby hospitals and blood banks, Nominatim for
 * geocoding. Data © OpenStreetMap contributors (ODbL), attributed in the
 * admin UI. Both services ask for light, identified use: requests carry a
 * contact in the User-Agent and Nominatim calls are at most one per second.
 */

let lastNominatimAt = 0;
let lastOverpassAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Overpass returns at most this many elements per query; a full page means the result may be incomplete. */
export const OVERPASS_RESULT_CAP = 300;
const OVERPASS_MIN_GAP_MS = 2000;

function throttleCheck(status: number, retryAfter: string | null) {
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    const seconds = Number(retryAfter);
    throw new ProviderThrottledError(status, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null);
  }
}

/** A bounding box around a point; much cheaper for Overpass than `around`. Results are then filtered by real distance. */
export function boundingBox(point: { latitude: number; longitude: number }, radiusKm: number) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos((point.latitude * Math.PI) / 180));
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return { south: r(point.latitude - dLat), west: r(point.longitude - dLng), north: r(point.latitude + dLat), east: r(point.longitude + dLng) };
}

export function overpassQuery(point: { latitude: number; longitude: number }, radiusKm: number): string {
  const b = boundingBox(point, Math.min(radiusKm, 50));
  const box = `(${b.south},${b.west},${b.north},${b.east})`;
  return `[out:json][timeout:50];(nwr["healthcare"~"^(blood_donation|blood_bank|hospital)$"]${box};nwr["amenity"="hospital"]${box};nwr["healthcare:speciality"~"blood_bank|transfusion"]${box};nwr["amenity"~"^(clinic|doctors)$"]["name"~"blood",i]${box};);out center tags ${OVERPASS_RESULT_CAP};`;
}

export class OpenStreetMapProvider implements DiscoveryProvider {
  readonly name = "openstreetmap" as const;

  constructor(private readonly config: DiscoveryConfig) {}

  async searchNearby(point: { latitude: number; longitude: number }, radiusKm: number): Promise<DiscoveredInstitution[]> {
    return (await this.searchNearbyDetailed(point, radiusKm)).items;
  }

  async searchNearbyDetailed(point: { latitude: number; longitude: number }, radiusKm: number): Promise<{ items: DiscoveredInstitution[]; truncated: boolean }> {
    // Sequential and spaced: never more than one Overpass call at a time from this process.
    const wait = OVERPASS_MIN_GAP_MS - (Date.now() - lastOverpassAt);
    if (wait > 0) await sleep(wait);
    lastOverpassAt = Date.now();
    const res = await safeFetchText(this.config.overpassUrl, {
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: `data=${encodeURIComponent(overpassQuery(point, radiusKm))}`,
      accept: "application/json",
    });
    throttleCheck(res.status, res.retryAfter);
    if (res.status !== 200) throw new Error(`Overpass returned ${res.status}`);
    const parsed = JSON.parse(res.text) as { elements?: OsmElement[]; remark?: string };
    // Overpass reports a server-side timeout or memory limit in `remark` with HTTP 200: treat as overloaded.
    if (parsed.remark && /runtime error|timed out|out of memory/i.test(parsed.remark)) throw new ProviderThrottledError(504);
    const elements = parsed.elements ?? [];
    const within = elements
      .map(fromOsmElement)
      .filter((x): x is DiscoveredInstitution => x !== null && haversineKm(point, x) <= radiusKm);
    return { items: dedupeDiscovered(within), truncated: elements.length >= OVERPASS_RESULT_CAP };
  }

  async geocode(query: { address: string; locality: string; city: string }): Promise<{ latitude: number; longitude: number } | null> {
    const wait = 1100 - (Date.now() - lastNominatimAt);
    if (wait > 0) await sleep(wait);
    lastNominatimAt = Date.now();
    const params = new URLSearchParams({
      q: [query.address, query.locality, query.city, "India"].filter(Boolean).join(", "),
      format: "jsonv2",
      countrycodes: "in",
      limit: "1",
      ...(this.config.contactEmail ? { email: this.config.contactEmail } : {}),
    });
    const res = await safeFetchText(`${this.config.nominatimUrl}/search?${params}`, { userAgent: this.config.userAgent, timeoutMs: this.config.timeoutMs, accept: "application/json" });
    throttleCheck(res.status, res.retryAfter);
    if (res.status !== 200) throw new Error(`Nominatim returned ${res.status}`);
    const [hit] = JSON.parse(res.text) as { lat: string; lon: string }[];
    if (!hit) return null;
    const latitude = Number(hit.lat);
    const longitude = Number(hit.lon);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  }
}
