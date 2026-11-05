import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectToDatabase } from "@/lib/db/mongoose";
import { deriveAreas, runAreaRefresh, runDiscoverySweep } from "@/server/discovery/areas";
import { formatFacilitiesForWhatsApp, nearbyFacilitiesForRequest, UNVERIFIED_LABEL, VERIFIED_LABEL } from "@/server/discovery/nearby";
import type { DiscoveredInstitution } from "@/server/discovery/normalize";
import { ProviderThrottledError, type DiscoveryProvider } from "@/server/discovery/provider";
import { mergeDuplicatesNear, upsertDiscovered, validateContacts, type InstitutionRecord } from "@/server/discovery/records";
import { setDiscoveryProviderForTests } from "@/server/discovery/service";
import { getInstitutionDetail, setChannelStatus, setInstitutionStatus } from "@/server/institutions/service";
import { enqueueJob } from "@/server/jobs/queue";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { DiscoveryArea } from "@/server/models/institution-discovery-area";
import { Job } from "@/server/models/job";
import { createActiveRequest } from "./helpers/fixtures";

/**
 * Area discovery, refresh, merge, staleness, validation and the nearby
 * facilities service, against MongoDB with a fake discovery source (no
 * network). Run with MONGODB_URI_TEST set to a throwaway database.
 */

const enabled = Boolean(process.env.MONGODB_URI_TEST);
const ORIGIN = { latitude: 25.4358, longitude: 81.8463 };
const north = (km: number) => ({ latitude: Math.round((ORIGIN.latitude + km / 111.32) * 1e5) / 1e5, longitude: ORIGIN.longitude });
const admin = new Types.ObjectId();
const DAY = 24 * 60 * 60_000;

const place = (ref: string, name: string, km: number, extra: Partial<DiscoveredInstitution> = {}): DiscoveredInstitution => ({
  externalRef: ref, name, type: "hospital", capability: "hospital", capabilitySource: "source_tags",
  ...north(km), address: `${km} km Road`, city: "Prayagraj", locality: "Civil Lines", channels: [], sourceUrl: `https://www.openstreetmap.org/${ref.slice(4)}`, ...extra,
});
const phone = (ref: string, value: string) => ({ type: "phone" as const, value, source: "openstreetmap" as const, sourceUrl: `https://www.openstreetmap.org/${ref.slice(4)}` });

function fakeSource(results: () => DiscoveredInstitution[] | Error, options: { truncated?: boolean } = {}) {
  const calls = { search: 0, geocode: 0 };
  const provider: DiscoveryProvider = {
    name: "fake",
    async searchNearby() {
      throw new Error("detailed search expected");
    },
    async searchNearbyDetailed() {
      calls.search += 1;
      const r = results();
      if (r instanceof Error) throw r;
      return { items: r, truncated: options.truncated ?? false };
    },
    async geocode() {
      calls.geocode += 1;
      return ORIGIN;
    },
  };
  return { provider, calls };
}

async function donorAt(point: { latitude: number; longitude: number } | null, city = "Prayagraj") {
  await DonorProfile.create({
    userId: new Types.ObjectId(), bloodGroup: "B+", city, locality: "Civil Lines", registeredVia: "web", registeredAt: new Date(),
    ...(point ? { location: { type: "Point", coordinates: [point.longitude, point.latitude] } } : {}),
  });
}

const byRef = async (ref: string) => (await Institution.findOne({ externalRefs: ref }).lean()) as InstitutionRecord | null;

describe.skipIf(!enabled)("Discovery: areas, refresh, merge, validation, nearby facilities (MongoDB, fake source)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all([Institution, DiscoveryArea, DonorProfile, EmergencyRequest, Job].map((m) => m.syncIndexes()));
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  });
  afterEach(() => setDiscoveryProviderForTests(undefined));

  it("derives areas from donors and requests, queues due ones politely, and geocodes city-only places", async () => {
    await donorAt(north(1));
    await donorAt(north(2));
    await donorAt(null, "Varanasi");
    await createActiveRequest({ location: { type: "Point", coordinates: [ORIGIN.longitude, ORIGIN.latitude] } } as never);
    const source = fakeSource(() => []);
    setDiscoveryProviderForTests(source.provider);

    const areas = await deriveAreas();
    expect(areas.map((a) => a.kind).sort()).toEqual(["cell", "city"]);
    const cell = areas.find((a) => a.kind === "cell")!;
    expect(cell).toMatchObject({ donorPoints: 2, requestPoints: 1 });
    // The stored centre is the grid cell's own centre, not a donor's point.
    expect(cell.center).not.toEqual(north(1));

    const now = new Date();
    const sweep = await runDiscoverySweep(now);
    expect(sweep).toMatchObject({ areas: 2, geocoded: 1, queued: 1 });
    expect(source.calls.geocode).toBe(1);
    const jobs = await Job.find({ type: "discovery_area_refresh" }).sort({ runAt: 1 }).lean();
    expect(jobs).toHaveLength(1);
    // Spaced after the geocode call (DISCOVERY_REQUEST_DELAY_MS).
    expect(jobs[0].runAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30_000);
    expect(await Job.countDocuments({ type: "discovery_sweep", status: "queued" })).toBe(1); // next sweep
    expect(source.calls.search).toBe(0); // the sweep itself never searches

    // Running the sweep again in the same interval queues nothing twice.
    expect((await runDiscoverySweep(now)).queued).toBe(0);
  });

  it("refreshes an area: updates changed data, keeps admin-owned values, marks unseen records stale, never deletes", async () => {
    await donorAt(north(0.5));
    await deriveAreas();
    const area = (await DiscoveryArea.findOne({ kind: "cell" }).lean())!;
    const centre = { latitude: area.center!.coordinates![1], longitude: area.center!.coordinates![0] };
    const at = (ref: string, name: string, extra: Partial<DiscoveredInstitution> = {}) => ({ ...place(ref, name, 0), ...centre, ...extra });

    let round = 1;
    const source = fakeSource(() =>
      round === 1
        ? [
            at("osm:node/1", "Sangam Blood Centre", { type: "blood_bank", capability: "blood_bank", channels: [phone("osm:node/1", "+915322250001")], openingHours: "24/7" }),
            at("osm:node/2", "City General Hospital", { latitude: centre.latitude + 0.01, channels: [phone("osm:node/2", "+915322250002")] }),
            at("osm:node/3", "Closed Nursing Home Hospital", { latitude: centre.latitude - 0.01 }),
          ]
        : [
            at("osm:node/1", "Sangam Blood Centre (Govt)", { type: "blood_bank", capability: "blood_bank", channels: [phone("osm:node/1", "+915322250009")], openingHours: "Mo-Su 00:00-24:00" }),
            at("osm:node/2", "City General Hospital & Research", { latitude: centre.latitude + 0.01, channels: [phone("osm:node/2", "+915322250002")] }),
          ],
    );
    setDiscoveryProviderForTests(source.provider);
    const t1 = new Date();
    const first = await runAreaRefresh(area.key, t1);
    expect(first).toMatchObject({ status: "done", found: 3, created: 3, markedStale: 0 });
    const sangam1 = (await byRef("osm:node/1"))!;
    expect(sangam1).toMatchObject({ verificationStatus: "pending", review: { status: "unreviewed" }, openingHours: "24/7" });
    expect(sangam1.fieldSources.find((f) => f.field === "name")).toMatchObject({ source: "openstreetmap", value: "Sangam Blood Centre" });
    // Not due again until DISCOVERY_REFRESH_DAYS later.
    expect((await runAreaRefresh(area.key, new Date(t1.getTime() + DAY))).status).toBe("skipped");

    // An admin verifies City General: its name is admin-owned from now on.
    const general = (await byRef("osm:node/2"))!;
    await setInstitutionStatus(general._id.toString(), "verified", undefined, admin, "t");

    round = 2;
    const t2 = new Date(t1.getTime() + 15 * DAY);
    const second = await runAreaRefresh(area.key, t2);
    expect(second).toMatchObject({ status: "done", found: 2, created: 0, updated: 2, markedStale: 1 });

    const sangam2 = (await byRef("osm:node/1"))!;
    expect(sangam2.displayName).toBe("Sangam Blood Centre (Govt)");
    expect(sangam2.openingHours).toBe("Mo-Su 00:00-24:00");
    const oldPhone = sangam2.contactChannels.find((c) => c.value === "+915322250001")!;
    const newPhone = sangam2.contactChannels.find((c) => c.value === "+915322250009")!;
    expect(oldPhone.staleSince).toEqual(t2);
    expect(newPhone).toMatchObject({ status: "unverified", source: "openstreetmap" });
    expect(newPhone.lastSeenAt).toEqual(t2);

    const general2 = (await byRef("osm:node/2"))!;
    expect(general2.displayName).toBe("City General Hospital");
    expect(general2.fieldSources.find((f) => f.field === "name")?.pendingValue).toBe("City General Hospital & Research");

    const closed = (await byRef("osm:node/3"))!;
    expect(closed.staleSince).toEqual(t2);
    expect(await Institution.countDocuments()).toBe(3); // nothing deleted

    // Admin API view shows sources and statuses.
    const detail = await getInstitutionDetail(sangam2._id.toString());
    expect(detail.channels.find((c) => c.value === "+915322250001")).toMatchObject({ displayStatus: "stale", source: "openstreetmap" });
    expect(detail.sourceRecords[0]).toMatchObject({ ref: "osm:node/1", provider: "openstreetmap" });
  });

  it("never marks records stale after a truncated result", async () => {
    await donorAt(north(0.5));
    await deriveAreas();
    const area = (await DiscoveryArea.findOne({ kind: "cell" }).lean())!;
    const centre = { latitude: area.center!.coordinates![1], longitude: area.center!.coordinates![0] };
    await Institution.create({ type: "hospital", legalName: "Old Hospital", displayName: "Old Hospital", address: "x", city: "Prayagraj", cityNormalized: "prayagraj", locality: "x", location: { type: "Point", coordinates: [centre.longitude, centre.latitude] }, source: "openstreetmap", externalRefs: ["osm:node/99"], review: { status: "unreviewed" }, lastSeenAt: new Date(Date.now() - 30 * DAY) });
    setDiscoveryProviderForTests(fakeSource(() => [], { truncated: true }).provider);
    expect((await runAreaRefresh(area.key, new Date())).markedStale).toBe(0);
  });

  it("merges duplicates into one institution keeping every source, but never admin or verified records", async () => {
    const now = new Date();
    const base = { type: "hospital" as const, address: "x", city: "Prayagraj", cityNormalized: "prayagraj", locality: "x", source: "openstreetmap" as const, review: { status: "unreviewed" as const }, lastSeenAt: now, discoveredAt: now };
    const ch = (value: string, ref: string) => ({ type: "phone", value, source: "openstreetmap", sourceUrl: `https://www.openstreetmap.org/${ref}`, retrievedAt: now, status: "unverified" });
    const a = await Institution.create({ ...base, legalName: "Kamla Nehru Hospital", displayName: "Kamla Nehru Hospital", location: { type: "Point", coordinates: [ORIGIN.longitude, ORIGIN.latitude] }, externalRefs: ["osm:way/7"], contactChannels: [ch("+915322466000", "way/7")] });
    const b = await Institution.create({ ...base, legalName: "Kamla Nehru Memorial Hospital", displayName: "Kamla Nehru Memorial Hospital", location: { type: "Point", coordinates: [north(0.4).longitude, north(0.4).latitude] }, externalRefs: ["osm:node/8"], contactChannels: [ch("+915322466000", "node/8"), { ...ch("+919876500008", "node/8") }] });
    const adminRecord = await Institution.create({ ...base, source: "admin", legalName: "Kamla Nehru Hospital", displayName: "Kamla Nehru Hospital", location: { type: "Point", coordinates: [north(0.01).longitude, north(0.01).latitude] }, review: { status: "approved" } });

    expect(await mergeDuplicatesNear(ORIGIN, 2, now)).toBe(2);
    const survivor = (await Institution.findById(adminRecord._id).lean())!;
    expect(survivor.externalRefs.sort()).toEqual(["osm:node/8", "osm:way/7"]);
    expect(survivor.contactChannels.map((c) => c.value).sort()).toEqual(["+915322466000", "+919876500008"]);
    for (const id of [a._id, b._id]) {
      const loser = (await Institution.findById(id).lean())!;
      expect(loser).toMatchObject({ mergedInto: adminRecord._id, review: { status: "excluded" }, externalRefs: [] });
    }
    // A later discovery of either source record updates the survivor, not a new record; the admin's name stays.
    const updated = await upsertDiscovered({ ...place("osm:node/8", "KNM Hospital (new name)", 0.4), channels: [phone("osm:node/8", "+915322466000")] }, "Prayagraj", new Date());
    expect(updated._id).toEqual(adminRecord._id);
    expect(updated.displayName).toBe("Kamla Nehru Hospital");
    expect(await Institution.countDocuments({ mergedInto: { $exists: false } })).toBe(1);
  });

  it("validates contacts: an impossible email domain is never used for outreach; admin-verified ones keep their status", async () => {
    const now = new Date();
    const inst = await Institution.create({
      type: "hospital", legalName: "Check Hospital", displayName: "Check Hospital", address: "x", city: "Prayagraj", cityNormalized: "prayagraj", locality: "x",
      source: "openstreetmap", review: { status: "approved" },
      contactChannels: [
        { type: "email", value: "desk@nowhere.invalid", source: "openstreetmap", retrievedAt: now, status: "unverified" },
        { type: "email", value: "kept@also.invalid", source: "admin", retrievedAt: now, status: "verified" },
        { type: "email", value: "bb@hospital.example", source: "openstreetmap", retrievedAt: now, status: "unverified" },
        { type: "phone", value: "+911111111111", source: "openstreetmap", retrievedAt: now, status: "unverified" },
      ],
    });
    await validateContacts([(await Institution.findById(inst._id).lean()) as InstitutionRecord], { now });
    const after = (await Institution.findById(inst._id).lean())!;
    const get = (v: string) => after.contactChannels.find((c) => c.value === v)!;
    expect(get("desk@nowhere.invalid")).toMatchObject({ status: "invalid", validation: { state: "invalid" } });
    expect(get("kept@also.invalid")).toMatchObject({ status: "verified", validation: { state: "invalid" } });
    expect(get("bb@hospital.example")).toMatchObject({ status: "unverified", validation: { state: "unknown" } });
    expect(get("+911111111111")).toMatchObject({ status: "invalid", validation: { reason: "repeated_digits" } });
    const detail = await getInstitutionDetail(inst._id.toString());
    // The admin's verification stands; the failed check is shown next to it for them to review.
    expect(detail.channels.filter((c) => c.usableForOutreach).map((c) => c.value).sort()).toEqual(["bb@hospital.example", "kept@also.invalid"]);
  });

  it("backs off on 429/504: the area and every queued area job wait, nothing retries at once", async () => {
    await donorAt(north(0.5));
    await deriveAreas();
    const area = (await DiscoveryArea.findOne({ kind: "cell" }).lean())!;
    const now = new Date();
    await enqueueJob("discovery_area_refresh", "discovery_area:other:1", { areaKey: "other" }, { runAt: now });
    setDiscoveryProviderForTests(fakeSource(() => new ProviderThrottledError(429)).provider);
    expect((await runAreaRefresh(area.key, now)).status).toBe("throttled");
    const after = (await DiscoveryArea.findOne({ key: area.key }).lean())!;
    expect(after.consecutiveFailures).toBe(1);
    expect(after.nextRunAt.getTime()).toBe(now.getTime() + 60 * 60_000);
    expect((await Job.findOne({ key: "discovery_area:other:1" }).lean())!.runAt.getTime()).toBe(now.getTime() + 60 * 60_000);
  });

  it("nearbyFacilitiesForRequest: verified first, unverified labelled, stale/merged/invalid left out, stock unknown", async () => {
    const now = new Date();
    const request = await createActiveRequest({ location: { type: "Point", coordinates: [ORIGIN.longitude, ORIGIN.latitude] } } as never);
    const mk = (name: string, km: number, extra: Record<string, unknown> = {}) =>
      Institution.create({ type: "hospital", legalName: name, displayName: name, address: `${km} km Road`, city: "Prayagraj", cityNormalized: "prayagraj", locality: "Civil Lines", location: { type: "Point", coordinates: [north(km).longitude, north(km).latitude] }, source: "openstreetmap", review: { status: "unreviewed" }, ...extra });
    const near = await mk("Near Blood Bank", 1, { type: "blood_bank", capability: "blood_bank", contactChannels: [{ type: "phone", value: "+915322250001", source: "openstreetmap", retrievedAt: now, status: "unverified" }, { type: "phone", value: "+915322250002", source: "openstreetmap", retrievedAt: now, status: "invalid" }] });
    const verified = await mk("Verified District Hospital", 6, { contactChannels: [{ type: "phone", value: "+915322250003", source: "admin", retrievedAt: now, status: "verified" }] });
    await setInstitutionStatus(verified._id.toString(), "verified", undefined, admin, "t");
    await mk("Gone Hospital", 2, { staleSince: now });
    await mk("Merged Hospital", 2, { mergedInto: verified._id, review: { status: "excluded" } });
    await mk("Excluded Hospital", 2, { review: { status: "excluded" } });
    await mk("Far Hospital", 60);

    const result = (await nearbyFacilitiesForRequest(request.publicRequestId))!;
    expect(result.facilities.map((f) => [f.name, f.verification])).toEqual([
      ["Verified District Hospital", "verified"],
      ["Near Blood Bank", "unverified"],
    ]);
    expect(result.facilities[0]).toMatchObject({ label: VERIFIED_LABEL, phones: [{ value: "+915322250003", verified: true }] });
    expect(result.facilities[1]).toMatchObject({ label: UNVERIFIED_LABEL, distanceKm: 1, phones: [{ value: "+915322250001", verified: false }], availability: { status: "unknown" } });
    expect(result).toMatchObject({ origin: "requester_device", verifiedCount: 1, unverifiedCount: 1, attribution: expect.stringMatching(/OpenStreetMap/) });
    expect(await nearbyFacilitiesForRequest(request._id.toString())).toMatchObject({ requestId: request.publicRequestId });
    expect(await nearbyFacilitiesForRequest("MX-NOTREAL1")).toBeNull();
    const text = formatFacilitiesForWhatsApp(result);
    expect(text).toMatch(/1\. Verified District Hospital/);
    expect(text).toMatch(/\(unverified\)/);
    expect(text).toMatch(/e-RaktKosh/);

    // An admin marking a phone invalid removes it everywhere.
    const nearDoc = (await Institution.findById(near._id).lean())!;
    await setChannelStatus(near._id.toString(), nearDoc.contactChannels[0]._id.toString(), "invalid", admin, "t");
    expect((await nearbyFacilitiesForRequest(request.publicRequestId))!.facilities[1].phones).toEqual([]);
  });
});
