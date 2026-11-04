import "server-only";
import type { DiscoveryConfig } from "@/lib/discovery/config";
import { dedupeDiscovered, fromOsmElement, type DiscoveredInstitution, type OsmElement } from "@/server/discovery/normalize";
import { haversineKm } from "@/server/matching/engine";
import type { DiscoveryProvider } from "@/server/discovery/provider";
import { safeFetchText } from "@/server/discovery/safe-fetch";

/**
 * OpenStreetMap: Overpass for nearby hospitals and blood banks, Nominatim for
 * geocoding. Data © OpenStreetMap contributors (ODbL), attributed in the
 * admin UI. Both services ask for light, identified use: requests carry a
 * contact in the User-Agent and Nominatim calls are at most one per second.
 */

let lastNominatimAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  return `[out:json][timeout:50];(nwr["healthcare"~"^(blood_donation|blood_bank|hospital)$"]${box};nwr["amenity"="hospital"]${box};);out center tags 300;`;
}

export class OpenStreetMapProvider implements DiscoveryProvider {
  readonly name = "openstreetmap" as const;

  constructor(private readonly config: DiscoveryConfig) {}

  async searchNearby(point: { latitude: number; longitude: number }, radiusKm: number): Promise<DiscoveredInstitution[]> {
    const res = await safeFetchText(this.config.overpassUrl, {
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: `data=${encodeURIComponent(overpassQuery(point, radiusKm))}`,
      accept: "application/json",
    });
    if (res.status !== 200) throw new Error(`Overpass returned ${res.status}`);
    const elements = (JSON.parse(res.text) as { elements?: OsmElement[] }).elements ?? [];
    const within = elements
      .map(fromOsmElement)
      .filter((x): x is DiscoveredInstitution => x !== null && haversineKm(point, x) <= radiusKm);
    return dedupeDiscovered(within);
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
    if (res.status !== 200) throw new Error(`Nominatim returned ${res.status}`);
    const [hit] = JSON.parse(res.text) as { lat: string; lon: string }[];
    if (!hit) return null;
    const latitude = Number(hit.lat);
    const longitude = Number(hit.lon);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  }
}
