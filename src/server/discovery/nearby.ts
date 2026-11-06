import "server-only";
import { Types } from "mongoose";
import { CAPABILITY_LABELS, type InstitutionCapability } from "@/features/coordination/schemas";
import type { NearbyFacilitiesResult, NearbyFacility } from "@/features/institutions/types";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { activeAvailabilitySource } from "@/server/discovery/availability";
import { rankInstitutions } from "@/server/discovery/normalize";
import { haversineKm } from "@/server/matching/engine";
import { originFor } from "@/server/matching/service";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution, type InstitutionDoc } from "@/server/models/institution";

/**
 * Hospitals and blood banks near a request, for the requester (WhatsApp bot,
 * tracking page) and coordinators. Read-only and fast: it uses what
 * discovery has already stored and never calls an external service.
 *
 * - Verified institutions (checked by the MarutiX team) come first; others
 *   follow, each clearly labelled as unverified public information.
 * - Excluded, rejected, suspended, merged and stale records are left out
 *   (stale ones stay only if an admin verified them).
 * - Only public, institutional phone numbers and websites are returned; no
 *   staff contacts, no emails, nothing invalid, opted-out or no longer published.
 * - Blood stock is "unknown" (no public live source; see availability.ts).
 */

type Record_ = InstitutionDoc & { _id: Types.ObjectId };
type Channel = Record_["contactChannels"][number];

export const VERIFIED_LABEL = "Verified by MarutiX";
export const UNVERIFIED_LABEL = "Unverified: from public listings (OpenStreetMap / its website). Call to confirm before going.";
const OSM_ATTRIBUTION = "Data © OpenStreetMap contributors (ODbL)";
/** Two decimals ≈ 1 km: enough to draw a search area, never a precise point. */
const roundTo1Km = (v: number) => Math.round(v * 100) / 100;

const usablePhone = (c: Channel) => c.type === "phone" && c.status !== "invalid" && c.status !== "opted_out" && !(c.staleSince && c.status !== "verified");
const usableSite = (c: Channel) => c.type === "website" && c.status !== "invalid" && c.status !== "opted_out" && !c.staleSince && c.validation?.state !== "invalid";

async function loadRequest(requestRef: string) {
  const byId = Types.ObjectId.isValid(requestRef) && /^[a-f0-9]{24}$/i.test(requestRef);
  return EmergencyRequest.findOne(byId ? { _id: requestRef } : { publicRequestId: requestRef.trim().toUpperCase() }, {
    publicRequestId: 1, city: 1, cityNormalized: 1, institutionId: 1, location: 1, geocodedLocation: 1, bloodGroup: 1, component: 1,
  }).lean();
}

/**
 * Nearby facilities for one request (ObjectId string or public ID such as
 * "MX-7K3Q9P2A"). Returns null if the request doesn't exist. Callers must
 * already have authorised the viewer for this request.
 */
/**
 * `includeDeviceCentre`: also return the map centre when it comes from the requester's
 * device (admin views only). Tracking links can be shared with family, so by default the
 * centre is returned only when it is a public place (the hospital or its geocoded address).
 */
export async function nearbyFacilitiesForRequest(
  requestRef: string,
  options: { limit?: number; radiusKm?: number; includeDeviceCentre?: boolean } = {},
): Promise<NearbyFacilitiesResult | null> {
  await connectToDatabase();
  const request = await loadRequest(requestRef);
  if (!request) return null;
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
  const radiusKm = options.radiusKm ?? getCoordinationConfig().outreachRadiusKm;
  const origin = await originFor(request);

  const filter: Record<string, unknown> = {
    verificationStatus: { $nin: ["rejected", "suspended"] },
    "review.status": { $ne: "excluded" },
    mergedInto: { $exists: false },
    $or: [{ staleSince: { $exists: false } }, { verificationStatus: "verified" }],
    ...(origin
      ? { location: { $geoWithin: { $centerSphere: [[origin.point.longitude, origin.point.latitude], radiusKm / 6378.1] } } }
      : { cityNormalized: request.cityNormalized }),
  };
  const docs = (await Institution.find(filter).limit(300).lean()) as Record_[];
  if (request.institutionId && !docs.some((d) => d._id.equals(request.institutionId!))) {
    const linked = (await Institution.findOne({ _id: request.institutionId, mergedInto: { $exists: false } }).lean()) as Record_ | null;
    if (linked) docs.push(linked);
  }

  const items = docs.map((d) => {
    const coords = d.location?.coordinates;
    const p = coords?.length === 2 ? { longitude: coords[0], latitude: coords[1] } : null;
    return { id: d._id.toString(), capability: (d.capability ?? "hospital") as InstitutionCapability, distanceKm: origin && p ? Math.round(haversineKm(origin.point, p) * 10) / 10 : null, point: p, doc: d };
  });
  const verified = rankInstitutions(items.filter((i) => i.doc.verificationStatus === "verified"));
  const others = rankInstitutions(items.filter((i) => i.doc.verificationStatus !== "verified"));
  const chosen = [...verified, ...others].slice(0, limit);

  const availability = activeAvailabilitySource();
  const facilities: NearbyFacility[] = [];
  for (const { id, capability, distanceKm, point, doc } of chosen) {
    const isVerified = doc.verificationStatus === "verified";
    const phones = (doc.contactChannels ?? []).filter(usablePhone)
      .sort((a, b) => Number(b.status === "verified") - Number(a.status === "verified"))
      .slice(0, 2)
      .map((c) => ({ value: c.value, verified: c.status === "verified", source: c.source }));
    // An admin-entered public phone on a verified institution.
    if (doc.publicPhone && !phones.some((p) => p.value === doc.publicPhone)) phones.unshift({ value: doc.publicPhone, verified: isVerified, source: "admin" });
    const site = (doc.contactChannels ?? []).find(usableSite);
    const answer = await availability.lookup({ institutionId: id, externalRefs: doc.externalRefs ?? [], bloodGroup: request.bloodGroup, component: request.component });
    facilities.push({
      id,
      name: doc.displayName,
      type: doc.type,
      capability,
      capabilityLabel: CAPABILITY_LABELS[capability],
      capabilitySource: doc.capabilitySource ?? "admin",
      distanceKm,
      location: point,
      address: [doc.address, doc.locality, doc.city].filter((v) => v && v !== "Not listed" && v !== "Address not listed in the source").join(", "),
      openingHours: doc.openingHours ?? null,
      phones: phones.slice(0, 2),
      website: site?.value ?? null,
      verification: isVerified ? "verified" : "unverified",
      label: isVerified ? VERIFIED_LABEL : UNVERIFIED_LABEL,
      source: doc.source ?? "admin",
      lastSeenAt: doc.lastSeenAt?.toISOString() ?? null,
      availability: answer,
    });
  }

  return {
    requestId: request.publicRequestId,
    origin: origin?.source ?? (facilities.length ? "city" : null),
    radiusKm: origin ? radiusKm : null,
    center:
      origin && (origin.source !== "requester_device" || options.includeDeviceCentre)
        ? { latitude: roundTo1Km(origin.point.latitude), longitude: roundTo1Km(origin.point.longitude) }
        : null,
    facilities,
    verifiedCount: facilities.filter((f) => f.verification === "verified").length,
    unverifiedCount: facilities.filter((f) => f.verification === "unverified").length,
    attribution: facilities.some((f) => f.source === "openstreetmap") ? OSM_ATTRIBUTION : null,
    availabilityNote: facilities[0]?.availability.note ?? null,
  };
}

/** Plain-text lines for a WhatsApp reply (no links beyond the institution's own site). */
export function formatFacilitiesForWhatsApp(result: NearbyFacilitiesResult): string {
  if (!result.facilities.length) return "MarutiX hasn't found hospitals or blood banks near this request yet. The team will follow up.";
  const lines = result.facilities.map((f, i) => {
    const where = f.distanceKm !== null ? ` (${f.distanceKm} km)` : "";
    const phone = f.phones[0] ? `\n   Phone: ${f.phones[0].value}${f.phones[0].verified ? "" : " (unverified)"}` : "";
    return `${i + 1}. ${f.name}${where}\n   ${f.capabilityLabel} · ${f.verification === "verified" ? VERIFIED_LABEL : "Unverified public listing"}${phone}`;
  });
  const notes = [result.unverifiedCount ? "Unverified entries come from public listings; call before going." : null, result.availabilityNote, result.attribution].filter(Boolean);
  return `${lines.join("\n")}\n\n${notes.join("\n")}`;
}
