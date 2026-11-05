import "server-only";
import { getDiscoveryConfig, type DiscoveryConfig } from "@/lib/discovery/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { ProviderThrottledError } from "@/server/discovery/provider";
import { enrichFromWebsites, markUnseenStale, mergeDuplicatesNear, newStats, upsertDiscovered, validateContacts, type InstitutionRecord } from "@/server/discovery/records";
import { activeDiscoveryProvider } from "@/server/discovery/service";
import { enqueueJob } from "@/server/jobs/queue";
import { haversineKm, normalisePlace } from "@/server/matching/engine";
import { DonorProfile } from "@/server/models/donor-profile";
import { Institution } from "@/server/models/institution";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { DiscoveryArea, type DiscoveryAreaDoc } from "@/server/models/institution-discovery-area";
import { Job } from "@/server/models/job";

/**
 * Proactive area discovery, run by the jobs worker with no admin input.
 *
 * `discovery_sweep` (every DISCOVERY_SWEEP_INTERVAL_MINUTES):
 *   1. derives areas from the database: donors' and requests' approximate
 *      points, clustered into grid cells DISCOVERY_AREA_RADIUS_KM wide, plus
 *      cities of donors/requests that have no point (geocoded, at most one
 *      per sweep). Nothing is hardcoded.
 *   2. queues `discovery_area_refresh` for at most DISCOVERY_AREAS_PER_RUN
 *      areas that are due (not refreshed for DISCOVERY_REFRESH_DAYS), spaced
 *      DISCOVERY_REQUEST_DELAY_MS apart, so calls to OSM are sequential.
 * `discovery_area_refresh` (one area): one Overpass search; upsert and merge;
 *   mark records the source no longer returns as stale (only after a
 *   complete result); validate contacts; read a few websites.
 * On HTTP 429/503/504 the area and every queued area job back off
 * (DISCOVERY_BACKOFF_MINUTES, doubling per consecutive failure).
 */

type AreaRecord = DiscoveryAreaDoc & { _id: unknown };
const MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000;
/** Leave headroom under the job lock (5 min) for one area job. */
const AREA_JOB_BUDGET_MS = 3.5 * 60_000;

const bucketOf = (now: Date, intervalMs: number) => Math.floor(now.getTime() / intervalMs);

/** Makes sure the current sweep is queued. Cheap and idempotent: one keyed insert. */
export async function ensureDiscoverySchedule(now = new Date()): Promise<boolean> {
  const config = getDiscoveryConfig();
  if (!config.areaRefresh || config.provider === "none") return false;
  return enqueueJob("discovery_sweep", `discovery_sweep:${bucketOf(now, config.sweepIntervalMs)}`, {}, { runAt: now, maxAttempts: 3 });
}

/* ------------------------------------------------------------------------ */
/* Deriving areas from the database                                         */
/* ------------------------------------------------------------------------ */

export interface DerivedArea {
  key: string;
  kind: "cell" | "city";
  center: { latitude: number; longitude: number } | null;
  city: string | null;
  donorPoints: number;
  requestPoints: number;
}

/** Cell index → the cell's own centre (never a person's point). */
export function cellCenter(latIndex: number, lngIndex: number, cellDeg: number) {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { latitude: r((latIndex + 0.5) * cellDeg), longitude: r((lngIndex + 0.5) * cellDeg) };
}

/** Pure clustering of counted cells and cities into areas, largest first. */
export function buildAreas(
  cells: { lat: number; lng: number; donors: number; requests: number }[],
  cities: { city: string; label: string; donors: number; requests: number }[],
  radiusKm: number,
  maxAreas: number,
): DerivedArea[] {
  const cellDeg = radiusKm / 111.32;
  const byKey = new Map<string, DerivedArea>();
  for (const c of cells) {
    const key = `cell:${c.lat}:${c.lng}@${radiusKm}`;
    const area = byKey.get(key) ?? { key, kind: "cell" as const, center: cellCenter(c.lat, c.lng, cellDeg), city: null, donorPoints: 0, requestPoints: 0 };
    area.donorPoints += c.donors;
    area.requestPoints += c.requests;
    byKey.set(key, area);
  }
  for (const c of cities) {
    if (!c.city) continue;
    const key = `city:${c.city}`.slice(0, 80);
    const area = byKey.get(key) ?? { key, kind: "city" as const, center: null, city: c.label.slice(0, 60), donorPoints: 0, requestPoints: 0 };
    area.donorPoints += c.donors;
    area.requestPoints += c.requests;
    byKey.set(key, area);
  }
  // Requests weigh more than donors: that's where emergencies happened.
  return [...byKey.values()].sort((a, b) => b.requestPoints * 3 + b.donorPoints - (a.requestPoints * 3 + a.donorPoints) || (a.key < b.key ? -1 : 1)).slice(0, maxAreas);
}

async function countCells(cellDeg: number) {
  const cellStage = (coords: unknown) => [
    { $project: { c: coords } },
    { $match: { "c.1": { $exists: true } } },
    { $group: { _id: { lat: { $floor: { $divide: [{ $arrayElemAt: ["$c", 1] }, cellDeg] } }, lng: { $floor: { $divide: [{ $arrayElemAt: ["$c", 0] }, cellDeg] } } }, n: { $sum: 1 } } },
  ];
  const [donors, requests] = await Promise.all([
    DonorProfile.aggregate<{ _id: { lat: number; lng: number }; n: number }>([{ $match: { "location.coordinates.1": { $exists: true } } }, ...cellStage("$location.coordinates")]),
    EmergencyRequest.aggregate<{ _id: { lat: number; lng: number }; n: number }>(cellStage({ $ifNull: ["$location.coordinates", "$geocodedLocation.coordinates"] })),
  ]);
  return [
    ...donors.map((d) => ({ lat: d._id.lat, lng: d._id.lng, donors: d.n, requests: 0 })),
    ...requests.map((r) => ({ lat: r._id.lat, lng: r._id.lng, donors: 0, requests: r.n })),
  ];
}

async function countCitiesWithoutPoints() {
  const [donors, requests] = await Promise.all([
    DonorProfile.aggregate<{ _id: string; n: number }>([{ $match: { "location.coordinates.1": { $exists: false } } }, { $group: { _id: "$city", n: { $sum: 1 } } }, { $limit: 2000 }]),
    EmergencyRequest.aggregate<{ _id: string; n: number }>([
      { $match: { "location.coordinates.1": { $exists: false }, "geocodedLocation.coordinates.1": { $exists: false } } },
      { $group: { _id: "$city", n: { $sum: 1 } } },
      { $limit: 2000 },
    ]),
  ]);
  return [
    ...donors.map((d) => ({ city: normalisePlace(d._id ?? ""), label: (d._id ?? "").trim(), donors: d.n, requests: 0 })),
    ...requests.map((r) => ({ city: normalisePlace(r._id ?? ""), label: (r._id ?? "").trim(), donors: 0, requests: r.n })),
  ];
}

/** Recomputes the area list from the database. Areas with nobody left are deactivated, never deleted. */
export async function deriveAreas(now = new Date()): Promise<DerivedArea[]> {
  await connectToDatabase();
  const config = getDiscoveryConfig();
  const areas = buildAreas(await countCells(config.areaRadiusKm / 111.32), await countCitiesWithoutPoints(), config.areaRadiusKm, config.maxAreas);
  for (const a of areas) {
    await DiscoveryArea.updateOne(
      { key: a.key },
      {
        $set: {
          kind: a.kind,
          radiusKm: config.areaRadiusKm,
          donorPoints: a.donorPoints,
          requestPoints: a.requestPoints,
          derivedAt: now,
          active: true,
          ...(a.city ? { city: a.city, label: a.city } : {}),
          ...(a.center ? { center: { type: "Point", coordinates: [a.center.longitude, a.center.latitude] } } : {}),
        },
        $setOnInsert: { nextRunAt: now, consecutiveFailures: 0 },
      },
      { upsert: true },
    );
  }
  await DiscoveryArea.updateMany({ key: { $nin: areas.map((a) => a.key) }, active: true }, { $set: { active: false } });
  return areas;
}

/* ------------------------------------------------------------------------ */
/* Sweep and per-area refresh                                               */
/* ------------------------------------------------------------------------ */

const backoffFor = (failures: number, baseMs: number) => Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, failures - 1));

/** Pushes every queued area job past `until`: one throttled answer slows the whole sweep down. */
async function postponeQueuedAreaJobs(until: Date) {
  await Job.updateMany({ type: "discovery_area_refresh", status: "queued", runAt: { $lt: until } }, { $set: { runAt: until } });
}

export interface SweepResult {
  areas: number;
  queued: number;
  geocoded: number;
}

/** Job `discovery_sweep`. Never calls OSM except for at most one city geocode. */
export async function runDiscoverySweep(now = new Date()): Promise<SweepResult> {
  await connectToDatabase();
  const config = getDiscoveryConfig();
  const provider = activeDiscoveryProvider();
  const result: SweepResult = { areas: 0, queued: 0, geocoded: 0 };
  if (!config.areaRefresh || !provider) return result;

  result.areas = (await deriveAreas(now)).length;

  // Geocode one city-only area per sweep (Nominatim: light use).
  const city = (await DiscoveryArea.findOne({ active: true, kind: "city", "center.coordinates.1": { $exists: false }, nextRunAt: { $lte: now } }).sort({ requestPoints: -1, donorPoints: -1 }).lean()) as AreaRecord | null;
  if (city?.city) {
    try {
      const point = await provider.geocode({ address: "", locality: "", city: city.city });
      if (point) {
        await DiscoveryArea.updateOne({ _id: city._id }, { $set: { center: { type: "Point", coordinates: [Math.round(point.longitude * 1e4) / 1e4, Math.round(point.latitude * 1e4) / 1e4] }, nextRunAt: new Date(now.getTime() + config.requestDelayMs) } });
        result.geocoded = 1;
      } else {
        await DiscoveryArea.updateOne({ _id: city._id }, { $set: { nextRunAt: new Date(now.getTime() + config.refreshMs), lastError: "city not found by geocoder", lastRunAt: now } });
      }
    } catch (error) {
      const failures = (city.consecutiveFailures ?? 0) + 1;
      const wait = backoffFor(failures, config.backoffMs);
      await DiscoveryArea.updateOne({ _id: city._id }, { $set: { consecutiveFailures: failures, nextRunAt: new Date(now.getTime() + wait), lastError: `geocode: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`, lastRunAt: now } });
      if (error instanceof ProviderThrottledError) {
        await scheduleNextSweep(now, config);
        return result;
      }
    }
  }

  const due = (await DiscoveryArea.find({ active: true, "center.coordinates.1": { $exists: true }, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1, requestPoints: -1 }).limit(config.areasPerRun).lean()) as AreaRecord[];
  const bucket = bucketOf(now, config.sweepIntervalMs);
  // The first area waits one delay if we just geocoded, so OSM sees at most one call per delay.
  let at = now.getTime() + (result.geocoded ? config.requestDelayMs : 0);
  for (const area of due) {
    if (await enqueueJob("discovery_area_refresh", `discovery_area:${area.key}:${bucket}`, { areaKey: area.key }, { runAt: new Date(at), maxAttempts: 2 })) result.queued += 1;
    at += config.requestDelayMs;
  }
  await scheduleNextSweep(now, config);
  logger.info("discovery.sweep", { ...result });
  return result;
}

async function scheduleNextSweep(now: Date, config: DiscoveryConfig) {
  const next = bucketOf(now, config.sweepIntervalMs) + 1;
  await enqueueJob("discovery_sweep", `discovery_sweep:${next}`, {}, { runAt: new Date(next * config.sweepIntervalMs), maxAttempts: 3 });
}

export interface AreaRefreshResult {
  status: "done" | "skipped" | "throttled" | "failed";
  found: number;
  created: number;
  updated: number;
  merged: number;
  markedStale: number;
  truncated: boolean;
  validated: number;
  websitesRead: number;
  aiContacts: number;
}

/** Job `discovery_area_refresh`: discover and refresh one area. Idempotent: an area that isn't due is skipped. */
export async function runAreaRefresh(areaKey: string, now = new Date(), options: { force?: boolean } = {}): Promise<AreaRefreshResult> {
  await connectToDatabase();
  const config = getDiscoveryConfig();
  const provider = activeDiscoveryProvider();
  const empty: AreaRefreshResult = { status: "skipped", found: 0, created: 0, updated: 0, merged: 0, markedStale: 0, truncated: false, validated: 0, websitesRead: 0, aiContacts: 0 };
  const area = (await DiscoveryArea.findOne({ key: areaKey }).lean()) as AreaRecord | null;
  const coords = area?.center?.coordinates;
  if (!provider || !area || !coords || coords.length !== 2) return empty;
  if (!options.force && (!area.active || area.nextRunAt > now)) return empty;
  const center = { longitude: coords[0], latitude: coords[1] };
  const radiusKm = area.radiusKm;

  // A city whose centre lies in an area we already refresh needs no second search.
  if (area.kind === "city" && !options.force) {
    const cells = (await DiscoveryArea.find({ kind: "cell", active: true, "center.coordinates.1": { $exists: true } }, { center: 1, radiusKm: 1 }).lean()) as AreaRecord[];
    if (cells.some((c) => haversineKm(center, { longitude: c.center!.coordinates![0], latitude: c.center!.coordinates![1] }) <= c.radiusKm * 0.5)) {
      await DiscoveryArea.updateOne({ key: areaKey }, { $set: { nextRunAt: new Date(now.getTime() + config.refreshMs), lastRunAt: now, lastError: "covered by a nearby area" } });
      return empty;
    }
  }

  const started = Date.now();
  const deadline = started + AREA_JOB_BUDGET_MS;
  try {
    const search = provider.searchNearbyDetailed
      ? await provider.searchNearbyDetailed(center, radiusKm)
      : { items: await provider.searchNearby(center, radiusKm), truncated: false };
    const stats = newStats();
    const records: InstitutionRecord[] = [];
    const fallbackCity = area.city ?? "Not listed";
    for (const item of search.items) records.push(await upsertDiscovered(item, item.city ?? fallbackCity, now, stats));
    const merged = stats.merged + (await mergeDuplicatesNear(center, radiusKm, now));
    const markedStale = search.truncated ? 0 : await markUnseenStale(center, radiusKm, now, now);
    const fresh = (await Institution.find({ _id: { $in: records.map((r) => r._id) }, mergedInto: { $exists: false } }).lean()) as InstitutionRecord[];
    const validated = await validateContacts(fresh, { now, websites: config.validateWebsites, deadline: deadline - 60_000 });
    const enrich = await enrichFromWebsites(fresh, now, { deadline });
    const result: AreaRefreshResult = { status: "done", found: search.items.length, created: stats.created, updated: stats.updated, merged, markedStale, truncated: search.truncated, validated, websitesRead: enrich.sites, aiContacts: enrich.aiAdded };
    await DiscoveryArea.updateOne(
      { key: areaKey },
      {
        $set: {
          lastRunAt: now,
          lastSuccessAt: now,
          nextRunAt: new Date(now.getTime() + config.refreshMs),
          consecutiveFailures: 0,
          lastResult: { found: result.found, created: result.created, updated: result.updated, merged: result.merged, markedStale: result.markedStale, truncated: result.truncated },
        },
        $unset: { lastError: 1 },
      },
    );
    logger.info("discovery.area_refreshed", { area: areaKey, ...result });
    return result;
  } catch (error) {
    const failures = (area.consecutiveFailures ?? 0) + 1;
    const throttled = error instanceof ProviderThrottledError;
    const wait = Math.max(throttled && error.retryAfterMs ? error.retryAfterMs : 0, backoffFor(failures, config.backoffMs));
    const until = new Date(now.getTime() + wait);
    await DiscoveryArea.updateOne({ key: areaKey }, { $set: { lastRunAt: now, consecutiveFailures: failures, nextRunAt: until, lastError: (error instanceof Error ? error.message : "failed").slice(0, 200) } });
    if (throttled) await postponeQueuedAreaJobs(until);
    logger.warn("discovery.area_failed", { area: areaKey, throttled, failures, errorName: error instanceof Error ? error.name : "UnknownError" });
    return { ...empty, status: throttled ? "throttled" : "failed" };
  }
}

/** Admin view of area discovery. */
export async function discoveryAreasOverview(limit = 100) {
  await connectToDatabase();
  const config = getDiscoveryConfig();
  const areas = (await DiscoveryArea.find({}).sort({ active: -1, requestPoints: -1, donorPoints: -1 }).limit(limit).lean()) as (AreaRecord & { updatedAt?: Date })[];
  return {
    enabled: config.areaRefresh && config.provider !== "none",
    provider: config.provider,
    refreshDays: Math.round(config.refreshMs / (24 * 60 * 60_000)),
    radiusKm: config.areaRadiusKm,
    areas: areas.map((a) => ({
      key: a.key,
      kind: a.kind,
      label: a.label ?? a.city ?? null,
      center: a.center?.coordinates?.length === 2 ? { latitude: a.center.coordinates[1], longitude: a.center.coordinates[0] } : null,
      radiusKm: a.radiusKm,
      active: a.active,
      donorPoints: a.donorPoints,
      requestPoints: a.requestPoints,
      lastRunAt: a.lastRunAt?.toISOString() ?? null,
      lastSuccessAt: a.lastSuccessAt?.toISOString() ?? null,
      nextRunAt: a.nextRunAt.toISOString(),
      lastResult: a.lastResult ?? null,
      consecutiveFailures: a.consecutiveFailures,
      lastError: a.lastError ?? null,
    })),
  };
}
