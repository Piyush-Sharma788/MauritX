import type { InstitutionCapability } from "@/features/coordination/schemas";
import { haversineKm, normalisePlace } from "@/server/matching/engine";

/**
 * Pure helpers that turn raw source records into institution candidates:
 * capability from explicit tags or the name, official contact fields as
 * published, and duplicate detection. No network access, so fully testable.
 * Contact values are never guessed: only what the source states is kept.
 */

export interface DiscoveredChannel {
  type: "email" | "phone" | "website";
  value: string;
  source: "openstreetmap" | "official_website";
  sourceUrl?: string;
}

export interface DiscoveredInstitution {
  externalRef: string;
  name: string;
  type: "hospital" | "blood_bank";
  capability: InstitutionCapability;
  capabilitySource: "source_tags" | "name";
  latitude: number;
  longitude: number;
  address: string | null;
  city: string | null;
  locality: string | null;
  channels: DiscoveredChannel[];
  sourceUrl: string;
}

export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const BLOOD_NAME = /\b(blood\s*(bank|centre|center|storage)|rakt\s*kosh|transfusion)\b/i;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** "0532 2256507; +91 532 2256 508" -> ["+915322256507", "+915322256508"]. Indian numbers only. */
export function normaliseIndianPhones(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[;,/]|\s{2,}/)) {
    let digits = part.replace(/[^\d+]/g, "");
    if (!digits) continue;
    if (digits.startsWith("+")) {
      if (!digits.startsWith("+91")) continue;
      digits = digits.slice(3);
    } else if (digits.startsWith("0091")) digits = digits.slice(4);
    else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = digits.slice(1);
    // 10 digits: a mobile, or an area code plus landline number.
    if (/^\d{10}$/.test(digits)) out.add(`+91${digits}`);
  }
  return [...out];
}

export function normaliseEmail(raw: string): string | null {
  const v = raw.trim().replace(/^mailto:/i, "").split("?")[0].toLowerCase();
  return EMAIL.test(v) && v.length <= 254 ? v : null;
}

export function normaliseWebsite(raw: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function capabilityFromOsm(tags: Record<string, string>): { capability: InstitutionCapability; source: "source_tags" | "name"; type: "hospital" | "blood_bank" } | null {
  const healthcare = tags.healthcare ?? "";
  const speciality = tags["healthcare:speciality"] ?? "";
  const name = tags.name ?? "";
  if (healthcare === "blood_donation" || healthcare === "blood_bank") return { capability: "blood_bank", source: "source_tags", type: "blood_bank" };
  const isHospital = tags.amenity === "hospital" || healthcare === "hospital";
  if (isHospital && /\b(blood_bank|transfusion|haematology)\b/.test(speciality)) return { capability: "hospital_with_blood_bank", source: "source_tags", type: "hospital" };
  if (BLOOD_NAME.test(name)) return { capability: isHospital ? "hospital_with_blood_bank" : "blood_bank", source: "name", type: isHospital ? "hospital" : "blood_bank" };
  if (isHospital) return { capability: "hospital", source: "source_tags", type: "hospital" };
  return null;
}

/** One OSM element to a candidate, or null when it isn't a named, located institution. */
export function fromOsmElement(e: OsmElement): DiscoveredInstitution | null {
  const tags = e.tags ?? {};
  const name = (tags.name ?? tags["name:en"] ?? "").trim();
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (!name || lat === undefined || lon === undefined) return null;
  const capability = capabilityFromOsm(tags);
  if (!capability) return null;
  const sourceUrl = `https://www.openstreetmap.org/${e.type}/${e.id}`;
  const channels: DiscoveredChannel[] = [];
  for (const key of ["phone", "contact:phone", "contact:mobile", "emergency:phone"]) {
    for (const phone of tags[key] ? normaliseIndianPhones(tags[key]) : []) channels.push({ type: "phone", value: phone, source: "openstreetmap", sourceUrl });
  }
  for (const key of ["email", "contact:email"]) {
    const email = tags[key] ? normaliseEmail(tags[key]) : null;
    if (email) channels.push({ type: "email", value: email, source: "openstreetmap", sourceUrl });
  }
  for (const key of ["website", "contact:website", "url"]) {
    const site = tags[key] ? normaliseWebsite(tags[key]) : null;
    if (site) channels.push({ type: "website", value: site, source: "openstreetmap", sourceUrl });
  }
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const address = [street, tags["addr:suburb"] ?? tags["addr:neighbourhood"], tags["addr:city"]].filter(Boolean).join(", ") || tags["addr:full"] || null;
  return {
    externalRef: `osm:${e.type}/${e.id}`,
    name: name.slice(0, 120),
    type: capability.type,
    capability: capability.capability,
    capabilitySource: capability.source,
    latitude: Math.round(lat * 1e5) / 1e5,
    longitude: Math.round(lon * 1e5) / 1e5,
    address: address ? address.slice(0, 200) : null,
    city: tags["addr:city"]?.slice(0, 60) ?? null,
    locality: (tags["addr:suburb"] ?? tags["addr:neighbourhood"])?.slice(0, 80) ?? null,
    channels: dedupeChannels(channels),
    sourceUrl,
  };
}

export function dedupeChannels<T extends { type: string; value: string }>(channels: T[]): T[] {
  const seen = new Set<string>();
  return channels.filter((c) => {
    const key = `${c.type}:${c.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const nameKey = (name: string) => normalisePlace(name).replace(/\b(hospital|hospitals|pvt|ltd|private|limited|the|and|centre|center)\b/g, "").replace(/\s+/g, " ").trim();

/** The same place mapped twice (a node and a building outline): same name within 300 m. */
export function isSamePlace(a: { name: string; latitude: number; longitude: number }, b: { name: string; latitude: number; longitude: number }): boolean {
  const ka = nameKey(a.name);
  const kb = nameKey(b.name);
  if (!ka || ka !== kb) return false;
  return haversineKm(a, b) <= 0.3;
}

/** Collapses duplicates in one result set, keeping the richer record. */
export function dedupeDiscovered(items: DiscoveredInstitution[]): DiscoveredInstitution[] {
  const kept: DiscoveredInstitution[] = [];
  for (const item of items) {
    const twin = kept.find((k) => k.externalRef === item.externalRef || isSamePlace(k, item));
    if (!twin) {
      kept.push({ ...item });
      continue;
    }
    twin.channels = dedupeChannels([...twin.channels, ...item.channels]);
    if (!twin.address && item.address) twin.address = item.address;
    if (item.capability !== "hospital" && twin.capability === "hospital") Object.assign(twin, { capability: item.capability, capabilitySource: item.capabilitySource });
  }
  return kept;
}

const CAPABILITY_ORDER: Record<InstitutionCapability, number> = { blood_bank: 0, hospital_with_blood_bank: 1, hospital: 2 };

/** Outreach order: stated blood capability first, then distance. Deterministic. */
export function rankInstitutions<T extends { capability: InstitutionCapability; distanceKm: number | null; id: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      CAPABILITY_ORDER[a.capability] - CAPABILITY_ORDER[b.capability] ||
      (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
      (a.id < b.id ? -1 : 1),
  );
}
