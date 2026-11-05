import type { RequestStatus } from "@/features/requests/schemas";

/**
 * Request lifecycle. Nothing becomes verified or fulfilled automatically:
 * those transitions always come from a person (an admin, or the requester
 * reporting their own outcome). Only expiry is automatic.
 */

const ADMIN_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  pending_verification: ["active", "verified", "cancelled"],
  verified: ["active", "partially_fulfilled", "fulfilled", "cancelled"],
  active: ["partially_fulfilled", "fulfilled", "cancelled"],
  partially_fulfilled: ["active", "fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
  expired: [],
};

/** Requesters can cancel, or report their own outcome. They can't verify. */
const REQUESTER_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  pending_verification: ["fulfilled", "cancelled"],
  verified: ["partially_fulfilled", "fulfilled", "cancelled"],
  active: ["partially_fulfilled", "fulfilled", "cancelled"],
  partially_fulfilled: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
  expired: [],
};

/**
 * A verified institution coordinating the request (coordinator contacts only)
 * can report its outcome, but can't verify, activate or cancel it.
 */
const INSTITUTION_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  pending_verification: [],
  verified: ["partially_fulfilled", "fulfilled"],
  active: ["partially_fulfilled", "fulfilled"],
  partially_fulfilled: ["fulfilled"],
  fulfilled: [],
  cancelled: [],
  expired: [],
};

export type TransitionActorType = "admin" | "requester" | "institution";

export function allowedTransitions(actor: TransitionActorType, from: RequestStatus): RequestStatus[] {
  return (actor === "admin" ? ADMIN_TRANSITIONS : actor === "institution" ? INSTITUTION_TRANSITIONS : REQUESTER_TRANSITIONS)[from];
}

export function canTransition(actor: TransitionActorType, from: RequestStatus, to: RequestStatus): boolean {
  return allowedTransitions(actor, from).includes(to);
}

export const FINAL_STATUSES: readonly RequestStatus[] = ["fulfilled", "cancelled", "expired"];

/**
 * When an open request lapses: 24 hours after the required-by time (or after
 * creation, if that's later), and never more than 14 days after creation.
 */
export function computeExpiry(createdAt: Date, requiredBy: Date): Date {
  const DAY = 24 * 60 * 60 * 1000;
  const base = Math.max(createdAt.getTime(), requiredBy.getTime()) + DAY;
  return new Date(Math.min(base, createdAt.getTime() + 14 * DAY));
}
