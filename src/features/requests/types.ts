import type { BloodGroup } from "@/features/donors/schemas";
import type { Component, Priority, RequestStatus } from "@/features/requests/schemas";

/** API views for emergency requests. Browser-safe. */

export type HistoryActor = "requester" | "admin" | "institution" | "system";

export interface PublicHistoryEntry {
  status: RequestStatus;
  at: string;
  actor: HistoryActor;
}

/** What a tracking link can see. Never contains patient or contact details, or coordinates. */
export interface TrackedRequestView {
  publicRequestId: string;
  status: RequestStatus;
  priority: Priority;
  bloodGroup: BloodGroup;
  component: Component;
  unitsRequested: number;
  requiredBy: string;
  hospital: { name: string; address: string; city: string; locality: string; phone: string | null };
  /** Set only after a MarutiX admin verified the request with the hospital. */
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  history: PublicHistoryEntry[];
  link: { scope: "manage" | "view" | "donor_contacts"; expiresAt: string };
  /** Present only for the requester's manage link. */
  manage: {
    contactMaskedPhone: string;
    allowedStatuses: RequestStatus[];
    deviceLocationShared: boolean;
    whatsappUpdates: boolean;
    shareLinks: { id: string; createdAt: string; expiresAt: string; revoked: boolean; scope: "view" | "donor_contacts" }[];
  } | null;
  /** Phase 6 coordination: institutions and donors. Absent on donor-contact links. */
  coordination: RequesterCoordinationView | null;
  /** Only on a donor_contacts link: consenting donors' contacts. Each view is logged. */
  donorContacts: DonorContactView[] | null;
}

export interface RequesterDonorView {
  responseId: string;
  firstName: string;
  bloodGroup: string;
  area: string;
  response: "interested" | "unavailable" | "later";
  coordinationStatus: string | null;
  /** The donor agreed to share their contact; it is revealed on request and logged. */
  contactAvailable: boolean;
  requesterContactedAt: string | null;
}

export interface RequesterCoordinationView {
  automation: { status: string; donorPhase: string; currentZone: string | null; donorsAlerted: number } | null;
  institutions: { name: string; type: string; distanceKm: number | null; contacted: boolean; response: { status: string; label: string; at: string } | null }[];
  donorCounts: { interested: number; contactsShared: number };
  /** Manage link only. */
  donors: RequesterDonorView[] | null;
  history: { summary: string; at: string }[];
}

export interface DonorContactView {
  responseId: string;
  firstName: string;
  bloodGroup: string;
  area: string;
  phone: string;
}

export interface CreateRequestResponse {
  publicRequestId: string;
  status: RequestStatus;
  /** Private link that lets the requester update or cancel. Shown once; save it. */
  manageUrl: string;
  manageLinkExpiresAt: string;
  whatsappConfirmation: "queued" | "not_requested" | "unavailable" | "suppressed";
  replayed: boolean;
}

export interface AdminRequestSummary {
  publicRequestId: string;
  status: RequestStatus;
  priority: Priority;
  bloodGroup: BloodGroup;
  component: Component;
  unitsRequested: number;
  hospitalName: string;
  city: string;
  locality: string;
  requiredBy: string;
  createdAt: string;
}

export interface AdminHistoryEntry extends PublicHistoryEntry {
  note: string | null;
}

export interface AdminRequestDetail extends AdminRequestSummary {
  patientName: string;
  patientAge: number | null;
  contactName: string;
  contactPhone: string;
  hospitalAddress: string;
  hospitalPhone: string | null;
  /** Approximate (~100 m) device location at submission. Not the verified hospital location. */
  location: { latitude: number; longitude: number } | null;
  verifiedAt: string | null;
  whatsappUpdates: boolean;
  consentAcceptedAt: string;
  privacyNoticeVersion: string;
  expiresAt: string;
  closedAt: string | null;
  history: AdminHistoryEntry[];
  allowedStatuses: RequestStatus[];
  links: { id: string; scope: "manage" | "view" | "donor_contacts"; createdBy: string; createdAt: string; expiresAt: string; revoked: boolean }[];
}

export interface AdminRequestStats {
  total: number;
  byStatus: Record<RequestStatus, number>;
}

export interface AdminRequestList {
  stats: AdminRequestStats;
  requests: AdminRequestSummary[];
  nextCursor: string | null;
}
