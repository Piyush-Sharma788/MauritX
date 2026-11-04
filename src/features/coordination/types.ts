import type {
  AvailabilityStatus,
  ContactRole,
  ContactStatus,
  CoordinationStatus,
  DonorResponse,
  InstitutionStatus,
  InstitutionType,
} from "@/features/coordination/schemas";
import type { BloodGroup } from "@/features/donors/schemas";
import type { Component, RequestStatus } from "@/features/requests/schemas";
import type { MessageKind, MessageStatus, WhatsAppStatusResponse } from "@/features/whatsapp/types";

/** Admin views for matching, alerts, responses, institutions and operations. Browser-safe. */

export interface MatchingCandidateView {
  rank: number;
  donorFirstName: string;
  distanceKm: number | null;
  basis: "distance" | "same_city";
  reasons: string[];
  alertStatus: MessageStatus | null;
  response: DonorResponse | null;
}

export interface MatchingRunView {
  id: string;
  createdAt: string;
  radiusKm: number;
  basis: "distance" | "city";
  originSource: "institution" | "requester_device" | null;
  policyVersion: string;
  policyReviewStatus: string;
  eligibleGroups: string[];
  scanned: number;
  excluded: Record<string, number>;
  candidates: MatchingCandidateView[];
}

export interface AlertBatchResult {
  queued: number;
  suppressed: number;
  duplicates: number;
  remainingCandidates: number;
}

export interface ResponseView {
  id: string;
  donorFirstName: string;
  /** Present only when the donor agreed to share their contact details for this request. */
  donorPhone: string | null;
  contactSharing: "consented" | "declined" | "pending";
  response: DonorResponse;
  coordinationStatus: CoordinationStatus | null;
  allowedNext: CoordinationStatus[];
  respondedAt: string;
  history: { status: CoordinationStatus; at: string; actor: "donor" | "admin" | "institution"; note: string | null }[];
}

export interface CoordinationSummary {
  alerts: Record<"queued" | "sent" | "delivered" | "read" | "failed" | "suppressed", number>;
  interested: number;
  unavailable: number;
  donationsConfirmed: number;
  institution: { id: string; displayName: string; acknowledgedAt: string | null } | null;
  alertsPaused: boolean;
  alertable: boolean;
}

export interface InstitutionSummary {
  id: string;
  type: InstitutionType;
  displayName: string;
  city: string;
  locality: string;
  verificationStatus: InstitutionStatus;
  verifiedContacts: number;
  createdAt: string;
}

export interface InstitutionContactView {
  id: string;
  name: string;
  maskedPhone: string;
  role: ContactRole;
  status: ContactStatus;
  verifiedAt: string | null;
}

export interface AvailabilityReportView {
  id: string;
  bloodGroup: BloodGroup;
  component: Component;
  status: AvailabilityStatus;
  units: number | null;
  reportedAt: string;
  reportedBy: string;
}

export interface InstitutionDetail extends InstitutionSummary {
  legalName: string;
  address: string;
  publicPhone: string | null;
  licenceReference: string | null;
  verifiedAt: string | null;
  statusNote: string | null;
  contacts: InstitutionContactView[];
  availability: AvailabilityReportView[];
  openRequests: { publicRequestId: string; status: RequestStatus; bloodGroup: BloodGroup; acknowledgedAt: string | null }[];
}

export interface OperationsOverview {
  whatsapp: WhatsAppStatusResponse;
  settings: { botEnabled: boolean; alertsPaused: boolean; updatedAt: string | null };
  ai: { provider: "none" | "anthropic"; model: string | null };
  bot: {
    activeConversations: number;
    conversationsByFlow: Record<string, number>;
    inboundToday: number;
    inbound7Days: number;
    droppedWhileDisabled7Days: number;
    botErrors7Days: number;
    aiCalls7Days: number;
    aiErrors7Days: number;
    aiRejected7Days: number;
  };
  queue: Record<"queued" | "sending", number> & { failed24h: number; suppressed24h: number };
  coordination: {
    activeRequests: number;
    verifiedRequests: number;
    pendingVerification: number;
    alertsAttempted7Days: number;
    alertsDelivered7Days: number;
    interested7Days: number;
    unavailable7Days: number;
    donationsConfirmed7Days: number;
    fulfilled7Days: number;
  };
  institutions: { verified: number; pending: number };
}

export interface FailedMessageView {
  id: string;
  kind: MessageKind;
  recipient: string;
  failureCode: string | null;
  failedAt: string | null;
  attempts: number;
  requestPublicId: string | null;
  retryable: boolean;
}

export interface ConversationLogEntry {
  id: string;
  maskedPhone: string;
  flow: string;
  state: string;
  status: string;
  lastInboundAt: string | null;
  updatedAt: string;
}

export interface AuditEntryView {
  id: string;
  action: string;
  outcome: "success" | "failure";
  actor: string | null;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
}
