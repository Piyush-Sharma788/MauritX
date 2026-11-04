import "server-only";
import { Types } from "mongoose";
import { ALERTABLE_STATUSES, type RadiusKm } from "@/features/coordination/schemas";
import type { MatchingRunView } from "@/features/coordination/types";
import { AppError } from "@/lib/api/errors";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { matchDonors, normalisePlace, type DonorRecord, type MatchRequest } from "@/server/matching/engine";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { MatchingRun, type MatchingRunDoc } from "@/server/models/matching-run";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { RequestResponse } from "@/server/models/request-response";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";

const SCAN_LIMIT = 2000;
const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toPoint = (coords?: number[] | null) => (coords?.length === 2 ? { longitude: coords[0], latitude: coords[1] } : null);

type RunRecord = MatchingRunDoc & { _id: Types.ObjectId; createdAt: Date };

/** Where to measure distance from: the linked institution's location if known, else the requester's approximate device location. */
async function originFor(request: { institutionId?: Types.ObjectId | null; location?: { coordinates?: number[] | null } | null }) {
  if (request.institutionId) {
    const institution = await Institution.findById(request.institutionId, { location: 1 }).lean();
    const point = toPoint(institution?.location?.coordinates);
    if (point) return { point, source: "institution" as const };
  }
  const point = toPoint(request.location?.coordinates);
  return point ? { point, source: "requester_device" as const } : null;
}

/** Donor profiles in the search area, of any blood group, so the run can explain every exclusion. */
async function loadAreaDonors(origin: { latitude: number; longitude: number } | null, city: string, radiusKm: number) {
  const sameCity = { city: { $regex: `^\\s*${escapeRegex(city.trim())}\\s*$`, $options: "i" } };
  const filter = origin
    ? {
        $or: [
          { location: { $geoWithin: { $centerSphere: [[origin.longitude, origin.latitude], radiusKm / 6378.1] } } },
          { ...sameCity, "location.coordinates": { $exists: false } },
        ],
      }
    : sameCity;
  return DonorProfile.find(filter).limit(SCAN_LIMIT).lean();
}

export async function runMatching(publicRequestId: string, radiusKm: RadiusKm, adminUserId: Types.ObjectId, requestId: string, now = new Date()): Promise<MatchingRunView> {
  await connectToDatabase();
  const request = await EmergencyRequest.findOne({ publicRequestId }).lean();
  if (!request) throw new AppError(404, "NOT_FOUND", "We couldn't find that request.");
  if (!(ALERTABLE_STATUSES as readonly string[]).includes(request.status) || request.expiresAt <= now) {
    throw new AppError(409, "INVALID_TRANSITION", "Donor search is available only for verified requests that an admin has marked active.");
  }

  const config = getCoordinationConfig();
  const origin = await originFor(request);
  const profiles = await loadAreaDonors(origin?.point ?? null, request.city, radiusKm);
  const userIds = profiles.map((p) => p.userId);
  const users = await User.find({ _id: { $in: userIds } }, { status: 1, phoneLookup: 1 }).lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));
  const optedOut = new Set(
    (await MessagingOptOut.find({ phoneLookup: { $in: users.map((u) => u.phoneLookup) }, channel: "whatsapp" }, { phoneLookup: 1 }).lean()).map((o) => o.phoneLookup),
  );
  const contacted = new Set([
    ...(await NotificationEvent.find({ requestId: request._id.toString(), kind: "emergency_request", recipientUserId: { $in: userIds } }, { recipientUserId: 1 }).lean()).map((n) => n.recipientUserId!.toString()),
    ...(await RequestResponse.find({ requestId: request._id, donorUserId: { $in: userIds } }, { donorUserId: 1 }).lean()).map((r) => r.donorUserId.toString()),
  ]);

  const donors: DonorRecord[] = profiles.map((p) => {
    const user = userById.get(p.userId.toString());
    return {
      userId: p.userId.toString(),
      userStatus: user?.status ?? "deleted",
      phoneLookup: user?.phoneLookup ?? "",
      bloodGroup: p.bloodGroup,
      city: p.city,
      locality: p.locality,
      location: toPoint(p.location?.coordinates),
      availableForRequests: p.availableForRequests,
      consentAt: p.notificationConsentAt ?? null,
      consentWithdrawnAt: p.notificationConsentWithdrawnAt ?? null,
      pausedAt: p.notificationsPausedAt ?? null,
      channels: p.notificationChannels ?? [],
      lastDonationDate: p.lastDonationDate ?? null,
      optedOut: user ? optedOut.has(user.phoneLookup) : false,
      alreadyContacted: contacted.has(p.userId.toString()),
    };
  });

  const matchRequest: MatchRequest = {
    bloodGroup: request.bloodGroup,
    component: request.component,
    location: origin?.point ?? null,
    cityNormalized: request.cityNormalized,
    localityNormalized: normalisePlace(request.locality),
  };
  const result = matchDonors(matchRequest, donors, {
    radiusKm,
    now,
    minDonationIntervalDays: config.minDonationIntervalDays,
    maxCandidates: config.maxCandidates,
    requesterLookups: [request.contactPhoneLookup, request.requesterPhoneLookup].filter((v): v is string => Boolean(v)),
  });

  const run = await MatchingRun.create({
    requestId: request._id,
    radiusKm,
    policyVersion: result.policyVersion,
    policyReviewStatus: result.policyReviewStatus,
    basis: result.basis,
    eligibleGroups: result.eligibleGroups,
    candidates: result.candidates.map((c) => ({ ...c, donorUserId: new Types.ObjectId(c.donorUserId) })),
    excluded: Object.fromEntries(Object.entries(result.excluded).filter(([, n]) => n > 0)),
    scanned: result.scanned,
    createdBy: adminUserId,
  });
  await recordAudit({
    action: "matching.run_created",
    outcome: "success",
    requestId,
    actorUserId: adminUserId,
    resourceType: "emergency_request",
    resourceId: `${publicRequestId}:${result.candidates.length}`,
  });
  return toRunView(run.toObject() as RunRecord, origin?.source ?? null);
}

export async function getLatestRun(requestObjectId: Types.ObjectId): Promise<MatchingRunView | null> {
  await connectToDatabase();
  const run = (await MatchingRun.findOne({ requestId: requestObjectId }).sort({ createdAt: -1 }).lean()) as RunRecord | null;
  return run ? toRunView(run, null) : null;
}

export async function loadRun(runId: string, requestObjectId: Types.ObjectId): Promise<RunRecord | null> {
  if (!Types.ObjectId.isValid(runId)) return null;
  return (await MatchingRun.findOne({ _id: runId, requestId: requestObjectId }).lean()) as RunRecord | null;
}

async function toRunView(run: RunRecord, originSource: "institution" | "requester_device" | null): Promise<MatchingRunView> {
  const ids = run.candidates.map((c) => c.donorUserId);
  const [users, alerted, responses] = await Promise.all([
    User.find({ _id: { $in: ids } }, { displayName: 1 }).lean(),
    NotificationEvent.find({ matchingRunId: run._id }, { recipientUserId: 1, status: 1 }).lean(),
    RequestResponse.find({ requestId: run.requestId, donorUserId: { $in: ids } }, { donorUserId: 1, response: 1 }).lean(),
  ]);
  const name = new Map(users.map((u) => [u._id.toString(), u.displayName?.split(" ")[0] ?? "Donor"]));
  const alertStatus = new Map(alerted.map((a) => [a.recipientUserId?.toString() ?? "", a.status]));
  const response = new Map(responses.map((r) => [r.donorUserId.toString(), r.response]));
  const excluded = run.excluded instanceof Map ? Object.fromEntries(run.excluded) : ((run.excluded ?? {}) as Record<string, number>);
  return {
    id: run._id.toString(),
    createdAt: run.createdAt.toISOString(),
    radiusKm: run.radiusKm,
    basis: run.basis,
    originSource,
    policyVersion: run.policyVersion,
    policyReviewStatus: run.policyReviewStatus,
    eligibleGroups: run.eligibleGroups,
    scanned: run.scanned,
    excluded,
    candidates: run.candidates.map((c) => ({
      rank: c.rank,
      donorFirstName: name.get(c.donorUserId.toString()) ?? "Donor",
      distanceKm: c.distanceKm ?? null,
      basis: c.basis,
      reasons: c.reasons,
      alertStatus: alertStatus.get(c.donorUserId.toString()) ?? null,
      response: response.get(c.donorUserId.toString()) ?? null,
    })),
  };
}
