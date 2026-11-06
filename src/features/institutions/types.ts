import type { ChannelStatus, InstitutionCapability, InstitutionType } from "@/features/coordination/schemas";
import type { ContactChannelView, InstitutionDetail, InstitutionSummary } from "@/features/coordination/types";

/**
 * Source tracking for institutions (discovery). `displayStatus` combines the
 * admin status with automatic signals, for display:
 * verified (by an admin) / unverified / invalid / stale (no longer published
 * by its source) / opted_out.
 */
export type ChannelDisplayStatus = "verified" | "unverified" | "invalid" | "stale" | "opted_out";

export interface ChannelProvenanceView extends ContactChannelView {
  status: ChannelStatus;
  displayStatus: ChannelDisplayStatus;
  lastSeenAt: string | null;
  staleSince: string | null;
  /** AI-extracted values only. */
  confidence: number | null;
  validation: { state: "valid" | "invalid" | "unknown"; reason: string | null; checkedAt: string } | null;
  /** True when outreach may use it automatically (subject to review rules). */
  usableForOutreach: boolean;
}

export interface FieldSourceView {
  field: "name" | "address" | "openingHours" | "capability";
  value: string | null;
  source: string;
  sourceUrl: string | null;
  retrievedAt: string;
  lastSeenAt: string | null;
  confidence: number | null;
  /** A different value the source now reports for an admin-owned field. */
  pendingValue: string | null;
}

export interface SourceRecordView {
  ref: string;
  provider: string;
  url: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  staleSince: string | null;
}

export interface InstitutionSummaryWithSources extends InstitutionSummary {
  staleSince: string | null;
  mergedInto: string | null;
  unverifiedChannels: number;
  invalidChannels: number;
}

export interface InstitutionDetailWithSources extends InstitutionDetail {
  channels: ChannelProvenanceView[];
  staleSince: string | null;
  mergedInto: string | null;
  openingHours: string | null;
  fieldSources: FieldSourceView[];
  sourceRecords: SourceRecordView[];
  enrichedAt: string | null;
  validatedAt: string | null;
}

export interface NearbyFacility {
  id: string;
  name: string;
  type: InstitutionType;
  capability: InstitutionCapability;
  capabilityLabel: string;
  capabilitySource: string;
  distanceKm: number | null;
  /** The institution's public map position, when known (for maps). */
  location?: { latitude: number; longitude: number } | null;
  address: string;
  openingHours: string | null;
  phones: { value: string; verified: boolean; source: string }[];
  website: string | null;
  verification: "verified" | "unverified";
  label: string;
  source: string;
  lastSeenAt: string | null;
  availability: { status: "available" | "not_available" | "unknown"; source: string; asOf: string | null; units: number | null; note: string };
}

export interface NearbyFacilitiesResult {
  requestId: string;
  /** How the search centre was found; "city" when only the city name matched. */
  origin: "institution" | "requester_device" | "geocoded_address" | "city" | null;
  radiusKm: number | null;
  /** The search centre rounded to ~1 km, for maps. Omitted for a requester-device centre unless asked for (admin). */
  center?: { latitude: number; longitude: number } | null;
  facilities: NearbyFacility[];
  verifiedCount: number;
  unverifiedCount: number;
  attribution: string | null;
  availabilityNote: string | null;
}
