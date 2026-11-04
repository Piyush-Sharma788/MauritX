import type { CoordinationStatus } from "@/features/coordination/schemas";

/**
 * After a donor says they're interested, only people move the response
 * forward: a MarutiX coordinator (admin) or a verified institution contact.
 * Interest is never a donation; only "donation_confirmed" records one.
 */
const NEXT: Record<CoordinationStatus, CoordinationStatus[]> = {
  interested: ["coordinator_contacted", "hospital_coordination", "not_proceeding"],
  coordinator_contacted: ["hospital_coordination", "not_proceeding"],
  hospital_coordination: ["donor_arrived", "donation_confirmed", "not_proceeding"],
  donor_arrived: ["donation_confirmed", "not_proceeding"],
  donation_confirmed: [],
  not_proceeding: [],
};

export function allowedCoordination(from: CoordinationStatus | null | undefined): CoordinationStatus[] {
  return from ? NEXT[from] : [];
}

export function canAdvanceCoordination(from: CoordinationStatus | null | undefined, to: CoordinationStatus): boolean {
  return allowedCoordination(from).includes(to);
}
