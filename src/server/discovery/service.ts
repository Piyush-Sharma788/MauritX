import "server-only";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { ALERTABLE_STATUSES } from "@/features/coordination/schemas";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { getDiscoveryConfig } from "@/lib/discovery/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { recordEvent } from "@/server/coordination/events";
import { dedupeChannels, isSamePlace, rankInstitutions, type DiscoveredChannel, type DiscoveredInstitution } from "@/server/discovery/normalize";
import { OpenStreetMapProvider } from "@/server/discovery/openstreetmap";
import type { DiscoveryProvider } from "@/server/discovery/provider";
import { contactsFromWebsite } from "@/server/discovery/website";
import { haversineKm, normalisePlace } from "@/server/matching/engine";
import { originFor } from "@/server/matching/service";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution, type InstitutionDoc } from "@/server/models/institution";
import { InstitutionOutreach } from "@/server/models/institution-outreach";
import { recordAudit } from "@/server/services/audit";

/**
 * Nearby institution discovery for one activated request.
 *
 * 1. Find the search centre: linked institution, requester's pin, or (when a
 *    provider is configured) the hospital address geocoded to an approximate point.
 * 2. Ask the provider for hospitals and blood banks nearby, and upsert them as
 *    `pending` + `unreviewed` institutions with each contact's source and time.
 *    Duplicates (same source ID, or same name within 300 m) are merged.
 * 3. Optionally read official contact links from their websites.
 * 4. Rank every usable institution nearby (admin-added and discovered) and
 *    create one outreach record each, without contacting anyone yet.
 * Nothing discovered is treated as verified, and no contact is ever invented.
 */

const ENRICH_PER_RUN = 6;
const ENRICH_AGAIN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

let providerOverride: DiscoveryProvider | null | undefined;

export function setDiscoveryProviderForTests(provider: DiscoveryProvider | null | undefined) {
  providerOverride = provider;
}

function activeProvider(): DiscoveryProvider | null {
  if (providerOverride !== undefined) return providerOverride;
  const config = getDiscoveryConfig();
  return config.provider === "openstreetmap" ? new OpenStreetMapProvider(config) : null;
}

type InstitutionRecord = InstitutionDoc & { _id: Types.ObjectId };
const toPoint = (coords?: number[] | null) => (coords?.length === 2 ? { longitude: coords[0], latitude: coords[1] } : null);

function channelDocs(channels: DiscoveredChannel[], now: Date) {
  return channels.map((c) => ({ type: c.type, value: c.value, source: c.source, sourceUrl: c.sourceUrl, retrievedAt: now, status: "unverified" as const }));
}

/** Inserts a discovered place, or merges it into the record we already have. */
export async function upsertDiscovered(item: DiscoveredInstitution, fallbackCity: string, now = new Date()): Promise<InstitutionRecord> {
  let existing = (await Institution.findOne({ externalRefs: item.externalRef }).lean()) as InstitutionRecord | null;
  if (!existing) {
    const nearby = (await Institution.find({
      location: { $geoWithin: { $centerSphere: [[item.longitude, item.latitude], 0.3 / 6378.1] } },
    }).limit(20).lean()) as InstitutionRecord[];
    existing = nearby.find((n) => { const p = toPoint(n.location?.coordinates); return p ? isSamePlace({ name: n.displayName, ...p }, item) : false; }) ?? null;
  }

  if (existing) {
    // Never overwrite what an admin entered or corrected; only add new source data.
    const known = new Set((existing.contactChannels ?? []).map((c) => `${c.type}:${c.value.toLowerCase()}`));
    const fresh = item.channels.filter((c) => !known.has(`${c.type}:${c.value.toLowerCase()}`));
    await Institution.updateOne(
      { _id: existing._id },
      {
        $set: { lastSeenAt: now },
        $addToSet: { externalRefs: item.externalRef },
        ...(fresh.length ? { $push: { contactChannels: { $each: channelDocs(fresh, now) } } } : {}),
      },
    );
    return (await Institution.findById(existing._id).lean()) as InstitutionRecord;
  }

  const created = await Institution.create({
    type: item.type,
    legalName: item.name,
    displayName: item.name.slice(0, 80),
    address: item.address ?? "Address not listed in the source",
    city: item.city ?? fallbackCity,
    cityNormalized: normalisePlace(item.city ?? fallbackCity),
    locality: item.locality ?? "Not listed",
    location: { type: "Point", coordinates: [item.longitude, item.latitude] },
    verificationStatus: "pending",
    source: "openstreetmap",
    externalRefs: [item.externalRef],
    capability: item.capability,
    capabilitySource: item.capabilitySource,
    contactChannels: channelDocs(dedupeChannels(item.channels), now),
    review: { status: "unreviewed" },
    discoveredAt: now,
    lastSeenAt: now,
  });
  return created.toObject() as InstitutionRecord;
}

/** Adds official contact links from institutions' own websites. Polite: a few sites per run, each at most monthly. */
async function enrichFromWebsites(institutions: InstitutionRecord[], now: Date) {
  const config = getDiscoveryConfig();
  if (!config.websiteEnrichment) return;
  const targets = institutions
    .filter((i) => i.source === "openstreetmap" && i.review?.status !== "excluded")
    .filter((i) => !(i.contactChannels ?? []).some((c) => c.type === "email"))
    .filter((i) => (i.contactChannels ?? []).some((c) => c.type === "website" && c.status !== "invalid"))
    .filter((i) => !(i.contactChannels ?? []).some((c) => c.source === "official_website" && now.getTime() - c.retrievedAt.getTime() < ENRICH_AGAIN_AFTER_MS))
    .slice(0, ENRICH_PER_RUN);
  for (const institution of targets) {
    const site = institution.contactChannels.find((c) => c.type === "website" && c.status !== "invalid")!;
    const found = await contactsFromWebsite(site.value, { userAgent: config.userAgent, timeoutMs: Math.min(config.timeoutMs, 10_000) });
    const known = new Set(institution.contactChannels.map((c) => `${c.type}:${c.value.toLowerCase()}`));
    const fresh = found.filter((c) => !known.has(`${c.type}:${c.value.toLowerCase()}`));
    if (fresh.length) await Institution.updateOne({ _id: institution._id }, { $push: { contactChannels: { $each: channelDocs(fresh, now) } } });
  }
}

export interface DiscoveryResult {
  origin: "institution" | "requester_device" | "geocoded_address" | null;
  discovered: number;
  candidates: number;
  providerError: string | null;
}

export async function discoverForRequest(requestObjectId: string, now = new Date()): Promise<DiscoveryResult | null> {
  await connectToDatabase();
  const request = await EmergencyRequest.findById(requestObjectId).lean();
  if (!request || !(ALERTABLE_STATUSES as readonly string[]).includes(request.status) || request.automation?.status === "cancelled") return null;
  await EmergencyRequest.updateOne({ _id: request._id }, { $set: { "automation.discoveryStatus": "running" } });

  const config = getCoordinationConfig();
  const provider = activeProvider();
  let providerError: string | null = null;
  let discovered = 0;

  let origin = await originFor(request);
  if (!origin && provider) {
    try {
      const point = await provider.geocode({ address: request.hospitalAddress, locality: request.locality, city: request.city });
      if (point) {
        await EmergencyRequest.updateOne(
          { _id: request._id },
          { $set: { geocodedLocation: { type: "Point", coordinates: [Math.round(point.longitude * 1000) / 1000, Math.round(point.latitude * 1000) / 1000], source: "openstreetmap", at: now } } },
        );
        origin = { point, source: "geocoded_address" };
      }
    } catch (error) {
      providerError = `geocode: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`;
    }
  }

  if (provider && origin) {
    try {
      const found = await provider.searchNearby(origin.point, config.outreachRadiusKm);
      const records: InstitutionRecord[] = [];
      for (const item of found) records.push(await upsertDiscovered(item, request.city, now));
      discovered = found.length;
      await enrichFromWebsites(records, now);
    } catch (error) {
      providerError = `search: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`;
      logger.warn("discovery.provider_failed", { provider: provider.name, errorName: error instanceof Error ? error.name : "UnknownError" });
    }
  }

  // Every usable institution nearby, whatever its source.
  const usable = { verificationStatus: { $nin: ["rejected", "suspended"] as ("rejected" | "suspended")[] }, "review.status": { $ne: "excluded" as const } };
  const pool = (origin
    ? await Institution.find({ ...usable, location: { $geoWithin: { $centerSphere: [[origin.point.longitude, origin.point.latitude], config.outreachRadiusKm / 6378.1] } } }).limit(300).lean()
    : await Institution.find({ ...usable, cityNormalized: request.cityNormalized }).limit(300).lean()) as InstitutionRecord[];
  if (request.institutionId && !pool.some((p) => p._id.equals(request.institutionId!))) {
    const linked = (await Institution.findById(request.institutionId).lean()) as InstitutionRecord | null;
    if (linked) pool.push(linked);
  }
  const ranked = rankInstitutions(
    pool.map((i) => {
      const p = toPoint(i.location?.coordinates);
      return { id: i._id.toString(), capability: i.capability ?? "hospital", distanceKm: origin && p ? Math.round(haversineKm(origin.point, p) * 10) / 10 : null };
    }),
  ).slice(0, config.outreachMaxInstitutions);

  for (const [index, item] of ranked.entries()) {
    await InstitutionOutreach.updateOne(
      { requestId: request._id, institutionId: new Types.ObjectId(item.id) },
      { $setOnInsert: { rank: index + 1, distanceKm: item.distanceKm ?? undefined, status: "no_contact", discoveredAt: now } },
      { upsert: true },
    );
  }

  await EmergencyRequest.updateOne({ _id: request._id }, { $set: { "automation.discoveryStatus": providerError && !discovered ? "failed" : "done", "automation.discoveredAt": now } });
  const summary = ranked.length
    ? `Found ${ranked.length} hospital${ranked.length === 1 ? "" : "s"} or blood bank${ranked.length === 1 ? "" : "s"} nearby to contact.`
    : "No hospitals or blood banks with usable details were found nearby yet. The MarutiX team will follow up.";
  await recordEvent(request._id, providerError && !ranked.length ? "discovery_failed" : "discovery_completed", summary, { visibleToRequester: true, at: now });
  await recordAudit({
    action: providerError && !discovered ? "discovery.failed" : "discovery.completed",
    outcome: providerError && !discovered ? "failure" : "success",
    requestId: randomUUID(),
    resourceType: "emergency_request",
    resourceId: `${request.publicRequestId}:found=${discovered}:candidates=${ranked.length}${providerError ? `:${providerError.slice(0, 60)}` : ""}`,
  });
  return { origin: origin?.source ?? null, discovered, candidates: ranked.length, providerError };
}
