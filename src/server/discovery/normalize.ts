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
  source: "openstreetmap" | "official_website" | "ai_extracted";
  sourceUrl?: string;
  /** AI-extracted values only. */
  confidence?: number;
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
  /** As published (OSM `opening_hours`), not interpreted. */
  openingHours?: string | null;
  /** Other source records merged into this one (same place mapped twice). */
  alsoRefs?: string[];
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
  // Explicit blood tags (e.g. blood:whole=yes, donation:blood=yes) on a hospital.
  const bloodTagged = Object.entries(tags).some(([k, v]) => /^(blood:|donation:blood)/.test(k) && v === "yes");
  if (isHospital && (/\b(blood_bank|transfusion|haematology)\b/.test(speciality) || bloodTagged)) return { capability: "hospital_with_blood_bank", source: "source_tags", type: "hospital" };
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
    openingHours: tags.opening_hours?.trim().slice(0, 300) || null,
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

export const nameKey = (name: string) => normalisePlace(name).replace(/\b(hospital|hospitals|pvt|ltd|private|limited|the|and|centre|center|of)\b/g, "").replace(/\s+/g, " ").trim();

/** The same place mapped twice (a node and a building outline): same name within 300 m. */
export function isSamePlace(a: { name: string; latitude: number; longitude: number }, b: { name: string; latitude: number; longitude: number }): boolean {
  const ka = nameKey(a.name);
  const kb = nameKey(b.name);
  if (!ka || ka !== kb) return false;
  return haversineKm(a, b) <= 0.3;
}

/** Dice coefficient over character bigrams of the name keys: 1 for equal names, 0 for nothing in common. */
export function nameSimilarity(a: string, b: string): number {
  const ka = nameKey(a).replace(/\s+/g, "");
  const kb = nameKey(b).replace(/\s+/g, "");
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(ka);
  const gb = grams(kb);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(1, ka.length - 1 + kb.length - 1);
  return (2 * overlap) / total;
}

// Hosts many unrelated places use, and toll-free numbers chains share: not evidence of the same place.
const SHARED_HOSTS = /(^|\.)(facebook|instagram|twitter|x|linkedin|youtube|google|sites\.google|wordpress|blogspot|justdial|practo|wix|business\.site|linktr)\.(com|ee|in|site)$/i;
const SHARED_PHONE = /^\+91(1800|1860|1900)/;
const SHARED_EMAIL_HOSTS = /@(gmail|yahoo|hotmail|outlook|rediffmail|ymail|live|icloud)\.(com|co\.in|in)$/i;

export function websiteHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Contact values two records share that point to the same institution (not chains' shared helplines or social pages). */
export function sharedContacts(a: { type: string; value: string }[], b: { type: string; value: string }[]): string[] {
  const keys = (list: { type: string; value: string }[]) => {
    const out = new Set<string>();
    for (const c of list) {
      if (c.type === "phone" && !SHARED_PHONE.test(c.value)) out.add(`phone:${c.value}`);
      if (c.type === "email") out.add(`email:${c.value.toLowerCase()}`);
      if (c.type === "website") {
        const host = websiteHost(c.value);
        if (host && !SHARED_HOSTS.test(host)) out.add(`website:${host}`);
      }
    }
    return out;
  };
  const kb = keys(b);
  // A personal-webmail address shared by two places is weak evidence; keep it, but only with a close name (see below).
  return [...keys(a)].filter((k) => kb.has(k));
}

export interface PlaceLike {
  name: string;
  latitude: number;
  longitude: number;
  type?: "hospital" | "blood_bank";
  refs?: string[];
  channels?: { type: string; value: string }[];
}

/**
 * Why two records are the same institution, or null. Deterministic rules:
 * - a shared source record (OSM ref);
 * - the same name within 300 m (a node and its building outline);
 * - very similar names (≥ 0.8) within 150 m;
 * - a shared official phone, email or website host, and either within 100 m,
 *   or within 1 km with a related name (≥ 0.5).
 * A hospital and a separate blood bank on the same campus are never merged
 * unless they share a source record: they're different contacts.
 */
export function duplicateReason(a: PlaceLike, b: PlaceLike): string | null {
  if (a.refs?.some((r) => b.refs?.includes(r))) return "same_source_record";
  if (a.type && b.type && a.type !== b.type) return null;
  const km = haversineKm(a, b);
  if (km > 1) return null;
  const sim = nameSimilarity(a.name, b.name);
  if (sim === 1 && km <= 0.3) return "same_name_nearby";
  if (sim >= 0.8 && km <= 0.15) return "similar_name_nearby";
  const shared = sharedContacts(a.channels ?? [], b.channels ?? []).filter((k) => !(k.startsWith("email:") && SHARED_EMAIL_HOSTS.test(k)) || sim >= 0.5);
  if (shared.length && (km <= 0.1 || sim >= 0.5)) return `shared_${shared[0].split(":")[0]}`;
  return null;
}

const asPlace = (d: DiscoveredInstitution): PlaceLike => ({ ...d, refs: [d.externalRef, ...(d.alsoRefs ?? [])] });

/** Collapses duplicates in one result set, keeping the richer record and every source reference. */
export function dedupeDiscovered(items: DiscoveredInstitution[]): DiscoveredInstitution[] {
  const kept: DiscoveredInstitution[] = [];
  for (const item of items) {
    const twin = kept.find((k) => k.externalRef === item.externalRef || duplicateReason(asPlace(k), asPlace(item)) !== null);
    if (!twin) {
      kept.push({ ...item, alsoRefs: [...(item.alsoRefs ?? [])] });
      continue;
    }
    twin.channels = dedupeChannels([...twin.channels, ...item.channels]);
    if (!twin.address && item.address) twin.address = item.address;
    if (!twin.openingHours && item.openingHours) twin.openingHours = item.openingHours;
    if (item.externalRef !== twin.externalRef && !twin.alsoRefs!.includes(item.externalRef)) twin.alsoRefs!.push(item.externalRef);
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
