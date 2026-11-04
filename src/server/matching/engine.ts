import { BLOOD_GROUP_LABELS, type BloodGroup } from "@/features/donors/schemas";
import type { Component } from "@/features/requests/schemas";
import { eligibleDonorGroups, MATCHING_POLICY } from "@/server/matching/policy";

/**
 * Deterministic donor matching. Pure: the same inputs always give the same
 * ranked, explained result, so it is tested without a database. It finds
 * potential donors to contact. It never decides medical eligibility or
 * compatibility, and missing information is never treated as eligibility.
 */

export interface MatchRequest {
  bloodGroup: BloodGroup;
  component: Component;
  location: { latitude: number; longitude: number } | null;
  cityNormalized: string;
  localityNormalized?: string;
}

export interface DonorRecord {
  userId: string;
  userStatus: string;
  phoneLookup: string;
  bloodGroup: BloodGroup;
  city: string;
  locality: string;
  location: { latitude: number; longitude: number } | null;
  availableForRequests: boolean;
  consentAt: Date | null;
  consentWithdrawnAt: Date | null;
  pausedAt: Date | null;
  channels: string[];
  lastDonationDate: Date | null;
  optedOut: boolean;
  /** Already alerted about, or already answered, this request. */
  alreadyContacted: boolean;
}

export interface MatchOptions {
  radiusKm: number;
  now: Date;
  minDonationIntervalDays: number;
  maxCandidates: number;
  /** The requester's own number never gets an alert about their request. */
  requesterLookups?: string[];
}

export const EXCLUSION_REASONS = [
  "duplicate",
  "requester_self",
  "account_inactive",
  "opted_out",
  "no_alert_consent",
  "alerts_paused",
  "not_available",
  "donor_blood_group_unknown",
  "blood_group_not_matched",
  "recent_donation",
  "outside_radius",
  "different_city",
  "already_contacted",
  "over_candidate_limit",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface MatchCandidate {
  donorUserId: string;
  rank: number;
  distanceKm: number | null;
  basis: "distance" | "same_city";
  reasons: string[];
}

export interface MatchResult {
  policyVersion: string;
  policyReviewStatus: string;
  basis: "distance" | "city";
  eligibleGroups: string[];
  candidates: MatchCandidate[];
  excluded: Record<ExclusionReason, number>;
  scanned: number;
}

const EARTH_RADIUS_KM = 6371.0088;

/** Straight-line (great-circle) distance. Never a route distance or travel time. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const normalisePlace = (v: string) => v.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const DAY_MS = 24 * 60 * 60 * 1000;

export function matchDonors(request: MatchRequest, donors: DonorRecord[], options: MatchOptions): MatchResult {
  const groups = eligibleDonorGroups(request.bloodGroup, request.component);
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<ExclusionReason, number>;
  const requesterLookups = new Set(options.requesterLookups ?? []);
  const seen = new Set<string>();
  const accepted: Omit<MatchCandidate, "rank">[] = [];
  const exclude = (reason: ExclusionReason) => {
    excluded[reason] += 1;
  };

  for (const donor of donors) {
    if (seen.has(donor.userId)) {
      exclude("duplicate");
      continue;
    }
    seen.add(donor.userId);
    if (requesterLookups.has(donor.phoneLookup)) { exclude("requester_self"); continue; }
    if (donor.userStatus !== "active") { exclude("account_inactive"); continue; }
    if (donor.optedOut) { exclude("opted_out"); continue; }
    if (!donor.consentAt || donor.consentWithdrawnAt || !donor.channels.includes("whatsapp")) { exclude("no_alert_consent"); continue; }
    if (donor.pausedAt) { exclude("alerts_paused"); continue; }
    if (!donor.availableForRequests) { exclude("not_available"); continue; }
    if (donor.bloodGroup === "unknown") { exclude("donor_blood_group_unknown"); continue; }
    if (!(groups as string[]).includes(donor.bloodGroup)) { exclude("blood_group_not_matched"); continue; }
    if (donor.lastDonationDate && options.now.getTime() - donor.lastDonationDate.getTime() < options.minDonationIntervalDays * DAY_MS) {
      exclude("recent_donation");
      continue;
    }

    let distanceKm: number | null = null;
    let basis: MatchCandidate["basis"];
    const sameCity = normalisePlace(donor.city) === request.cityNormalized;
    if (request.location && donor.location) {
      distanceKm = Math.round(haversineKm(request.location, donor.location) * 10) / 10;
      if (distanceKm > options.radiusKm) { exclude("outside_radius"); continue; }
      basis = "distance";
    } else {
      if (!sameCity) { exclude("different_city"); continue; }
      basis = "same_city";
    }
    if (donor.alreadyContacted) { exclude("already_contacted"); continue; }

    const reasons = [
      `Self-reported blood group ${BLOOD_GROUP_LABELS[donor.bloodGroup]} is in the contact list for ${BLOOD_GROUP_LABELS[request.bloodGroup]} under policy ${MATCHING_POLICY.version}`,
      basis === "distance" ? `About ${distanceKm} km away in a straight line (not a route distance)` : `Same city (${donor.city}); distance unknown because a location wasn't shared`,
      "Alerts consented, not paused, marked available",
      donor.lastDonationDate
        ? `Last donation ${donor.lastDonationDate.toISOString().slice(0, 10)}, at least ${options.minDonationIntervalDays} days ago`
        : "Last donation date not provided; the blood centre will check",
    ];
    accepted.push({ donorUserId: donor.userId, distanceKm, basis, reasons });
  }

  const localityOf = new Map(donors.map((d) => [d.userId, normalisePlace(d.locality)]));
  accepted.sort((a, b) => {
    if (a.basis !== b.basis) return a.basis === "distance" ? -1 : 1;
    if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    if (request.localityNormalized) {
      const aLocal = localityOf.get(a.donorUserId) === request.localityNormalized ? 0 : 1;
      const bLocal = localityOf.get(b.donorUserId) === request.localityNormalized ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
    }
    return a.donorUserId < b.donorUserId ? -1 : a.donorUserId > b.donorUserId ? 1 : 0;
  });

  const kept = accepted.slice(0, options.maxCandidates);
  excluded.over_candidate_limit = accepted.length - kept.length;
  return {
    policyVersion: MATCHING_POLICY.version,
    policyReviewStatus: MATCHING_POLICY.reviewStatus,
    basis: request.location ? "distance" : "city",
    eligibleGroups: groups,
    candidates: kept.map((c, i) => ({ ...c, rank: i + 1 })),
    excluded,
    scanned: donors.length,
  };
}
