import "server-only";
import { Types } from "mongoose";
import { getDiscoveryConfig } from "@/lib/discovery/config";
import { logger } from "@/lib/logger";
import { extractWithAi } from "@/server/discovery/ai-extract";
import { dedupeChannels, duplicateReason, type DiscoveredChannel, type DiscoveredInstitution, type PlaceLike } from "@/server/discovery/normalize";
import { checkWebsite, validateEmail, validatePhone, type ValidationResult } from "@/server/discovery/validate";
import { readWebsite, relevantText } from "@/server/discovery/website";
import { normalisePlace } from "@/server/matching/engine";
import { Institution, type InstitutionDoc } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";

/**
 * How discovered data is stored, refreshed, merged and checked. Rules that
 * hold everywhere in this file:
 * - Nothing discovered is ever marked verified; only admins verify.
 * - A value an admin entered, corrected or verified is never overwritten.
 *   A different value from a source is kept as `pendingValue` for review.
 * - Records and contacts the source stops publishing are marked stale
 *   (`staleSince`), never deleted.
 * - Every value keeps its source, source URL, retrieval and last-seen time.
 */

export type InstitutionRecord = InstitutionDoc & { _id: Types.ObjectId; createdAt?: Date };
type Channel = InstitutionRecord["contactChannels"][number];
/** A plain field-provenance entry (see the model's fieldSourceSchema). */
interface FieldSource {
  field: "name" | "address" | "openingHours" | "capability";
  value?: string | null;
  source: "admin" | "openstreetmap" | "official_website" | "ai_extracted";
  sourceUrl?: string | null;
  retrievedAt: Date;
  lastSeenAt?: Date | null;
  confidence?: number | null;
  pendingValue?: string | null;
}

export interface UpsertStats {
  created: number;
  updated: number;
  merged: number;
}

export const newStats = (): UpsertStats => ({ created: 0, updated: 0, merged: 0 });

const toPoint = (coords?: number[] | null) => (coords?.length === 2 ? { longitude: coords[0], latitude: coords[1] } : null);
const channelKey = (c: { type: string; value: string }) => `${c.type}:${c.value.toLowerCase()}`;
const osmUrl = (ref: string) => (ref.startsWith("osm:") ? `https://www.openstreetmap.org/${ref.slice(4)}` : undefined);

function channelDocs(channels: DiscoveredChannel[], now: Date) {
  return channels.map((c) => ({
    type: c.type,
    value: c.value,
    source: c.source,
    sourceUrl: c.sourceUrl,
    retrievedAt: now,
    lastSeenAt: now,
    status: "unverified" as const,
    ...(c.confidence !== undefined ? { confidence: Math.round(c.confidence * 100) / 100 } : {}),
  }));
}

/** A stored institution as a duplicate-detection candidate. */
export function placeOf(doc: InstitutionRecord): PlaceLike | null {
  const p = toPoint(doc.location?.coordinates);
  if (!p) return null;
  return { name: doc.displayName, ...p, type: doc.type, refs: doc.externalRefs ?? [], channels: (doc.contactChannels ?? []).filter((c) => c.status !== "invalid") };
}

/** Admin-owned values: created by an admin, verified, or a field an admin set. */
function fieldIsAdminOwned(doc: InstitutionRecord, field: FieldSource["field"]): boolean {
  if (doc.source === "admin" || doc.verificationStatus === "verified") return true;
  return (doc.fieldSources ?? []).some((f) => f.field === field && f.source === "admin");
}

function setFieldSource(list: FieldSource[], entry: FieldSource): FieldSource[] {
  return [...list.filter((f) => f.field !== entry.field), entry];
}

const plainFields = (doc: InstitutionRecord): FieldSource[] => ((doc.fieldSources ?? []) as unknown as FieldSource[]).map((f) => ({ ...f }));

/* ------------------------------------------------------------------------ */
/* Merge                                                                    */
/* ------------------------------------------------------------------------ */

const winnerRank = (d: InstitutionRecord) =>
  (d.verificationStatus === "verified" ? 0 : 10) + (d.source === "admin" ? 0 : 5) + (d.review?.status === "approved" ? 0 : 2);

/**
 * Merges `loser` into `winner`, keeping every source: contacts, source
 * records and refs move to the winner; the loser is kept (so old outreach
 * history still resolves), excluded from review and points to the winner.
 * Refused when the loser holds anything only an admin should decide on.
 */
export async function mergeInstitutions(winnerId: Types.ObjectId, loserId: Types.ObjectId, reason: string, now = new Date()): Promise<boolean> {
  if (winnerId.equals(loserId)) return false;
  const [winner, loser] = (await Promise.all([Institution.findById(winnerId).lean(), Institution.findById(loserId).lean()])) as [InstitutionRecord | null, InstitutionRecord | null];
  if (!winner || !loser || loser.mergedInto || winner.mergedInto) return false;
  if (loser.source === "admin" || loser.verificationStatus === "verified") return false;
  if (await InstitutionContact.exists({ institutionId: loser._id })) return false;

  const known = new Set((winner.contactChannels ?? []).map(channelKey));
  const moved = (loser.contactChannels ?? []).filter((c) => !known.has(channelKey(c))).map((c) => {
    const { _id, ...rest } = c as Channel & { _id: Types.ObjectId };
    void _id;
    return rest;
  });
  const refs = loser.externalRefs ?? [];
  const records = [...(winner.sourceRecords ?? [])];
  for (const r of loser.sourceRecords ?? []) if (!records.some((w) => w.ref === r.ref)) records.push(r);

  // Free the refs first: externalRefs is unique across institutions.
  await Institution.updateOne(
    { _id: loser._id },
    {
      $set: {
        externalRefs: [],
        mergedInto: winner._id,
        mergedAt: now,
        review: { status: "excluded", reviewedAt: now, note: `Duplicate merged automatically into ${winner._id.toString()} (${reason}).`.slice(0, 300) },
      },
    },
  );
  await Institution.updateOne(
    { _id: winner._id },
    {
      $addToSet: { externalRefs: { $each: refs } },
      $set: {
        sourceRecords: records,
        ...(winner.capability === "hospital" && loser.capability !== "hospital" && winner.capabilitySource !== "admin" ? { capability: loser.capability, capabilitySource: loser.capabilitySource } : {}),
        ...(!winner.openingHours && loser.openingHours ? { openingHours: loser.openingHours } : {}),
        ...(!winner.discoveredAt && loser.discoveredAt ? { discoveredAt: loser.discoveredAt } : {}),
      },
      ...(moved.length ? { $push: { contactChannels: { $each: moved } } } : {}),
    },
  );
  logger.info("discovery.merged", { winner: winner._id.toString(), loser: loser._id.toString(), reason });
  return true;
}

/** Picks the record to keep among duplicates, and merges the others into it. Returns how many were merged. */
async function mergeGroup(docs: InstitutionRecord[], reason: string, now: Date): Promise<{ survivor: InstitutionRecord; merged: number }> {
  const sorted = [...docs].sort((a, b) => winnerRank(a) - winnerRank(b) || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  let merged = 0;
  for (const loser of sorted.slice(1)) if (await mergeInstitutions(sorted[0]._id, loser._id, reason, now)) merged += 1;
  return { survivor: (await Institution.findById(sorted[0]._id).lean()) as InstitutionRecord, merged };
}

/** Finds and merges duplicates among stored institutions within `radiusKm` of a point. */
export async function mergeDuplicatesNear(point: { latitude: number; longitude: number }, radiusKm: number, now = new Date()): Promise<number> {
  const docs = (await Institution.find({
    mergedInto: { $exists: false },
    location: { $geoWithin: { $centerSphere: [[point.longitude, point.latitude], radiusKm / 6378.1] } },
  }).limit(1000).lean()) as InstitutionRecord[];
  const places = docs.map(placeOf);
  const assigned = new Set<number>();
  let merged = 0;
  // Transitive groups: A~B and B~C puts A, B and C together.
  for (let i = 0; i < docs.length; i++) {
    if (assigned.has(i) || !places[i]) continue;
    const members = [i];
    assigned.add(i);
    let reason = "";
    for (let k = 0; k < members.length; k++) {
      for (let j = 0; j < docs.length; j++) {
        if (assigned.has(j) || !places[j]) continue;
        const why = duplicateReason(places[members[k]]!, places[j]!);
        if (why) {
          members.push(j);
          assigned.add(j);
          reason ||= why;
        }
      }
    }
    if (members.length < 2) continue;
    merged += (await mergeGroup(members.map((m) => docs[m]), reason, now)).merged;
  }
  return merged;
}

/* ------------------------------------------------------------------------ */
/* Upsert                                                                   */
/* ------------------------------------------------------------------------ */

/** Finds the stored record for a discovered place, merging stored duplicates it reveals. */
async function findExisting(item: DiscoveredInstitution, now: Date, stats: UpsertStats): Promise<InstitutionRecord | null> {
  const refs = [item.externalRef, ...(item.alsoRefs ?? [])];
  let byRef = (await Institution.find({ externalRefs: { $in: refs } }).lean()) as InstitutionRecord[];
  if (byRef.length > 1) {
    const { survivor, merged } = await mergeGroup(byRef, "same_source_record", now);
    stats.merged += merged;
    byRef = [survivor];
  }
  if (byRef[0]) return byRef[0];
  const nearby = (await Institution.find({
    mergedInto: { $exists: false },
    location: { $geoWithin: { $centerSphere: [[item.longitude, item.latitude], 1 / 6378.1] } },
  }).limit(50).lean()) as InstitutionRecord[];
  const candidate: PlaceLike = { ...item, refs };
  return nearby.find((n) => { const p = placeOf(n); return p ? duplicateReason(p, candidate) !== null : false; }) ?? null;
}

/**
 * Inserts a discovered place, or refreshes the record we already have:
 * - every source ref and record is kept (lastSeenAt updated, stale cleared);
 * - contacts still published get lastSeenAt; new ones are added unverified;
 *   ones this source record no longer publishes are marked stale;
 * - name, address and opening hours follow the source unless an admin owns
 *   them, in which case the source's value is kept as `pendingValue`.
 */
export async function upsertDiscovered(item: DiscoveredInstitution, fallbackCity: string, now = new Date(), stats: UpsertStats = newStats()): Promise<InstitutionRecord> {
  const refs = [item.externalRef, ...(item.alsoRefs ?? [])];
  const existing = await findExisting(item, now, stats);
  const sourceUrls = new Set(refs.map(osmUrl).filter(Boolean) as string[]);
  sourceUrls.add(item.sourceUrl);

  if (!existing) {
    stats.created += 1;
    const fieldSources: FieldSource[] = [
      { field: "name", value: item.name, source: "openstreetmap", sourceUrl: item.sourceUrl, retrievedAt: now, lastSeenAt: now },
      ...(item.address ? [{ field: "address" as const, value: item.address, source: "openstreetmap" as const, sourceUrl: item.sourceUrl, retrievedAt: now, lastSeenAt: now }] : []),
      ...(item.openingHours ? [{ field: "openingHours" as const, value: item.openingHours, source: "openstreetmap" as const, sourceUrl: item.sourceUrl, retrievedAt: now, lastSeenAt: now }] : []),
      { field: "capability", value: item.capability, source: "openstreetmap", sourceUrl: item.sourceUrl, retrievedAt: now, lastSeenAt: now },
    ];
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
      externalRefs: refs,
      capability: item.capability,
      capabilitySource: item.capabilitySource,
      contactChannels: channelDocs(dedupeChannels(item.channels), now),
      review: { status: "unreviewed" },
      discoveredAt: now,
      lastSeenAt: now,
      ...(item.openingHours ? { openingHours: item.openingHours } : {}),
      sourceRecords: refs.map((ref) => ({ ref, provider: "openstreetmap", url: osmUrl(ref), firstSeenAt: now, lastSeenAt: now })),
      fieldSources,
    });
    return created.toObject() as InstitutionRecord;
  }

  stats.updated += 1;
  const $set: Record<string, unknown> = { lastSeenAt: now };
  const $unset: Record<string, 1> = { staleSince: 1 };

  // Source records.
  const records = [...(existing.sourceRecords ?? [])].map((r) => (refs.includes(r.ref) ? { ...r, lastSeenAt: now, staleSince: undefined } : r));
  for (const ref of refs) if (!records.some((r) => r.ref === ref)) records.push({ ref, provider: "openstreetmap", url: osmUrl(ref), firstSeenAt: now, lastSeenAt: now } as (typeof records)[number]);
  $set.sourceRecords = records;

  // Fields: follow the source unless an admin owns the value.
  let fields = plainFields(existing);
  const apply = (field: "name" | "address" | "openingHours", value: string | null | undefined, current: string | null | undefined, write: (v: string) => void) => {
    if (!value) return;
    if (value === current) {
      fields = fields.map((f) => (f.field === field && f.source === "openstreetmap" ? { ...f, lastSeenAt: now } : f)) as FieldSource[];
      return;
    }
    if (fieldIsAdminOwned(existing, field) || fields.some((f) => f.field === field && (f.source === "official_website" || f.source === "admin"))) {
      const prior = fields.find((f) => f.field === field);
      fields = setFieldSource(fields, { ...(prior ?? { field, source: "admin", retrievedAt: now }), pendingValue: value.slice(0, 300) } as FieldSource);
      return;
    }
    write(value);
    fields = setFieldSource(fields, { field, value: value.slice(0, 300), source: "openstreetmap", sourceUrl: item.sourceUrl, retrievedAt: now, lastSeenAt: now } as FieldSource);
  };
  apply("name", item.name, existing.legalName, (v) => Object.assign($set, { legalName: v.slice(0, 120), displayName: v.slice(0, 80) }));
  apply("address", item.address, existing.address, (v) => Object.assign($set, { address: v.slice(0, 200), ...(item.locality ? { locality: item.locality } : {}) }));
  apply("openingHours", item.openingHours, existing.openingHours, (v) => Object.assign($set, { openingHours: v.slice(0, 300) }));
  // Capability follows the source tags only when it came from them; website/AI/admin evidence is kept.
  if (existing.capabilitySource === "source_tags" || existing.capabilitySource === "name") {
    if (existing.capability !== item.capability) Object.assign($set, { capability: item.capability, capabilitySource: item.capabilitySource });
  } else if (existing.capabilitySource !== "admin" && existing.capability === "hospital" && item.capability !== "hospital") {
    Object.assign($set, { capability: item.capability, capabilitySource: item.capabilitySource });
  }
  $set.fieldSources = fields;

  await Institution.updateOne({ _id: existing._id }, { $set, $unset, $addToSet: { externalRefs: { $each: refs } } });

  // Contacts: seen, new, or no longer published by this source record.
  const published = new Set(item.channels.map(channelKey));
  for (const c of existing.contactChannels ?? []) {
    const id = (c as Channel & { _id: Types.ObjectId })._id;
    if (published.has(channelKey(c))) {
      await Institution.updateOne({ _id: existing._id, "contactChannels._id": id }, { $set: { "contactChannels.$.lastSeenAt": now }, $unset: { "contactChannels.$.staleSince": 1 } });
    } else if (c.source === "openstreetmap" && c.sourceUrl && sourceUrls.has(c.sourceUrl) && !c.staleSince) {
      await Institution.updateOne({ _id: existing._id, "contactChannels._id": id }, { $set: { "contactChannels.$.staleSince": now } });
    }
  }
  const known = new Set((existing.contactChannels ?? []).map(channelKey));
  const fresh = dedupeChannels(item.channels).filter((c) => !known.has(channelKey(c)));
  if (fresh.length) await Institution.updateOne({ _id: existing._id }, { $push: { contactChannels: { $each: channelDocs(fresh, now) } } });
  return (await Institution.findById(existing._id).lean()) as InstitutionRecord;
}

/**
 * After a COMPLETE area search: discovered records inside the area that the
 * source no longer returned are marked stale (kept, never deleted). Only
 * records well inside the circle are considered, so edge effects don't count.
 */
export async function markUnseenStale(point: { latitude: number; longitude: number }, radiusKm: number, seenSince: Date, now = new Date()): Promise<number> {
  const result = await Institution.updateMany(
    {
      source: "openstreetmap",
      mergedInto: { $exists: false },
      staleSince: { $exists: false },
      lastSeenAt: { $lt: seenSince },
      location: { $geoWithin: { $centerSphere: [[point.longitude, point.latitude], (radiusKm * 0.9) / 6378.1] } },
    },
    { $set: { staleSince: now, "sourceRecords.$[].staleSince": now } },
  );
  return result.modifiedCount;
}

/* ------------------------------------------------------------------------ */
/* Validation                                                               */
/* ------------------------------------------------------------------------ */

const REVALIDATE_MS = 30 * 24 * 60 * 60_000;

/**
 * Checks contacts that were never checked (or not for 30 days). An invalid
 * result turns an UNVERIFIED contact `invalid` (so outreach never uses it);
 * an admin-verified contact keeps its status and only gets the check result.
 * Returns how many checks ran.
 */
export async function validateContacts(institutions: InstitutionRecord[], options: { now?: Date; budget?: number; websites?: boolean; deadline?: number } = {}): Promise<number> {
  const config = getDiscoveryConfig();
  if (!config.validateContacts) return 0;
  const now = options.now ?? new Date();
  let budget = options.budget ?? config.validatePerRun;
  let ran = 0;
  for (const institution of institutions) {
    for (const c of institution.contactChannels ?? []) {
      if (budget <= 0 || (options.deadline && Date.now() > options.deadline)) return ran;
      if (c.validation?.checkedAt && now.getTime() - c.validation.checkedAt.getTime() < REVALIDATE_MS) continue;
      if (c.status === "opted_out") continue;
      let result: ValidationResult | null = null;
      if (c.type === "email") result = await validateEmail(c.value, config.dnsTimeoutMs);
      else if (c.type === "phone") result = validatePhone(c.value);
      else if (c.type === "website" && options.websites) result = await checkWebsite(c.value, { userAgent: config.userAgent, timeoutMs: config.websiteTimeoutMs });
      if (!result) continue;
      if (c.type !== "phone") budget -= 1;
      ran += 1;
      const id = (c as Channel & { _id: Types.ObjectId })._id;
      // Websites are never auto-invalidated (they're not used for outreach, and outages are common).
      const invalidate = result.state === "invalid" && c.status === "unverified" && c.type !== "website";
      await Institution.updateOne(
        { _id: institution._id, "contactChannels._id": id },
        { $set: { "contactChannels.$.validation": { state: result.state, reason: result.reason, checkedAt: now }, ...(invalidate ? { "contactChannels.$.status": "invalid", "contactChannels.$.statusChangedAt": now } : {}) } },
      );
    }
    await Institution.updateOne({ _id: institution._id }, { $set: { validatedAt: now } });
  }
  return ran;
}

/* ------------------------------------------------------------------------ */
/* Website enrichment (+ optional AI extraction)                            */
/* ------------------------------------------------------------------------ */

export interface EnrichStats {
  sites: number;
  added: number;
  aiAdded: number;
}

/**
 * Reads institutions' own websites (robots.txt honoured, a few sites per
 * run, each at most once per DISCOVERY_ENRICH_AGAIN_DAYS). Deterministic
 * extraction always runs; with AI_PROVIDER=anthropic, Claude also reads the
 * contact-relevant parts of the text, and its accepted proposals are stored
 * unverified as `ai_extracted` with confidence and page URL.
 */
export async function enrichFromWebsites(institutions: InstitutionRecord[], now = new Date(), options: { limit?: number; deadline?: number } = {}): Promise<EnrichStats> {
  const config = getDiscoveryConfig();
  const stats: EnrichStats = { sites: 0, added: 0, aiAdded: 0 };
  if (!config.websiteEnrichment) return stats;
  const hasEmail = (i: InstitutionRecord) => (i.contactChannels ?? []).some((c) => c.type === "email" && c.status !== "invalid");
  const targets = institutions
    .filter((i) => i.source === "openstreetmap" && i.review?.status !== "excluded" && !i.mergedInto)
    .filter((i) => (i.contactChannels ?? []).some((c) => c.type === "website" && c.status !== "invalid"))
    .filter((i) => {
      const last = i.enrichedAt ?? (i.contactChannels ?? []).filter((c) => c.source === "official_website").map((c) => c.retrievedAt).sort((a, b) => b.getTime() - a.getTime())[0];
      return !last || now.getTime() - last.getTime() >= config.enrichAgainMs;
    })
    .sort((a, b) => Number(hasEmail(a)) - Number(hasEmail(b)))
    .slice(0, options.limit ?? config.enrichPerRun);

  for (const institution of targets) {
    if (options.deadline && Date.now() > options.deadline) break;
    stats.sites += 1;
    const site = institution.contactChannels.find((c) => c.type === "website" && c.status !== "invalid")!;
    const reading = await readWebsite(site.value, { userAgent: config.userAgent, timeoutMs: config.websiteTimeoutMs });
    const known = new Set(institution.contactChannels.map(channelKey));
    const fresh = reading.channels.filter((c) => !known.has(channelKey(c)));
    for (const c of fresh) known.add(channelKey(c));
    // Re-seen website contacts are refreshed.
    for (const c of institution.contactChannels) {
      if (reading.channels.some((r) => channelKey(r) === channelKey(c))) {
        await Institution.updateOne({ _id: institution._id, "contactChannels._id": (c as Channel & { _id: Types.ObjectId })._id }, { $set: { "contactChannels.$.lastSeenAt": now }, $unset: { "contactChannels.$.staleSince": 1 } });
      }
    }

    const $set: Record<string, unknown> = { enrichedAt: now };
    let fields = plainFields(institution);
    const capabilityOpen = institution.capabilitySource !== "admin" && institution.capability === "hospital";
    if (capabilityOpen && reading.bloodBankEvidence) {
      Object.assign($set, { capability: "hospital_with_blood_bank", capabilitySource: "official_website" });
      fields = setFieldSource(fields, { field: "capability", value: `hospital_with_blood_bank: "${reading.bloodBankEvidence.phrase}"`.slice(0, 300), source: "official_website", sourceUrl: reading.bloodBankEvidence.url, retrievedAt: now, lastSeenAt: now } as FieldSource);
    }

    const aiChannels: DiscoveredChannel[] = [];
    if (config.aiExtraction && reading.pages.length) {
      for (const page of reading.pages) {
        if (options.deadline && Date.now() > options.deadline) break;
        const text = relevantText(page.text, config.aiMaxInputChars);
        const ai = await extractWithAi({ institutionName: institution.displayName, pageUrl: page.url, text }, config.aiMinConfidence);
        if (!ai) continue;
        for (const e of ai.emails) if (!known.has(`email:${e.value}`)) { known.add(`email:${e.value}`); aiChannels.push({ type: "email", value: e.value, source: "ai_extracted", sourceUrl: page.url, confidence: e.confidence }); }
        for (const p of ai.phones) if (!known.has(`phone:${p.value}`)) { known.add(`phone:${p.value}`); aiChannels.push({ type: "phone", value: p.value, source: "ai_extracted", sourceUrl: page.url, confidence: p.confidence }); }
        if (ai.bloodBank && capabilityOpen && !$set.capability) {
          Object.assign($set, { capability: "hospital_with_blood_bank", capabilitySource: "ai_extracted" });
          fields = setFieldSource(fields, { field: "capability", value: `hospital_with_blood_bank: "${ai.bloodBank.evidence}"`.slice(0, 300), source: "ai_extracted", sourceUrl: page.url, retrievedAt: now, lastSeenAt: now, confidence: ai.bloodBank.confidence } as FieldSource);
        }
        if (ai.openingHours && !institution.openingHours && !fields.some((f) => f.field === "openingHours")) {
          fields = setFieldSource(fields, { field: "openingHours", value: ai.openingHours, source: "ai_extracted", sourceUrl: page.url, retrievedAt: now, lastSeenAt: now } as FieldSource);
          $set.openingHours = ai.openingHours;
        }
      }
    }
    $set.fieldSources = fields;
    const all = [...fresh, ...aiChannels];
    stats.added += fresh.length;
    stats.aiAdded += aiChannels.length;
    await Institution.updateOne({ _id: institution._id }, { $set, ...(all.length ? { $push: { contactChannels: { $each: channelDocs(all, now) } } } : {}) });
    if (!reading.reachable) {
      await Institution.updateOne(
        { _id: institution._id, "contactChannels._id": (site as Channel & { _id: Types.ObjectId })._id },
        { $set: { "contactChannels.$.validation": { state: "unknown", reason: "not_reachable_during_enrichment", checkedAt: now } } },
      );
    }
  }
  return stats;
}
