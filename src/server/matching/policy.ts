import type { BloodGroup } from "@/features/donors/schemas";
import type { Component } from "@/features/requests/schemas";

export type KnownBloodGroup = Exclude<BloodGroup, "unknown">;

/**
 * Which donors' self-reported blood groups may be *contacted* for a request.
 * This is not a compatibility decision: the blood centre always screens,
 * groups and cross-matches.
 *
 * Until qualified medical professionals review and approve wider rules, the
 * policy is exact ABO and Rh match for every component, the most conservative
 * choice (it never suggests a donor the clinical rules would reject). Wider
 * rules must be added to `additionalGroups` together with the reviewer and
 * date, and `reviewStatus` changed, never inferred in code.
 */
export const MATCHING_POLICY = {
  version: "2026-11-04.exact-abo-rh",
  reviewStatus: "pending_clinical_review" as "pending_clinical_review" | "approved",
  reviewedBy: null as string | null,
  reviewedOn: null as string | null,
  additionalGroups: {} as Partial<Record<Component, Partial<Record<KnownBloodGroup, KnownBloodGroup[]>>>>,
};

/** Donor groups that may be contacted for a request. Empty when the request's group isn't known. */
export function eligibleDonorGroups(requested: BloodGroup, component: Component, policy = MATCHING_POLICY): KnownBloodGroup[] {
  if (requested === "unknown") return [];
  const extra = policy.additionalGroups[component]?.[requested] ?? [];
  return [requested, ...extra.filter((g) => g !== requested)];
}
