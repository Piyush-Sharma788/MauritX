import type {
  AvailabilityStatus,
  ChannelStatus,
  ChannelType,
  InstitutionCapability,
  InstitutionResponse,
  InstitutionSource,
  OutreachStatus,
  ReviewStatus,
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
  originSource: "institution" | "requester_device" | "geocoded_address" | null;
  trigger: "admin" | "automatic";
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
  source: InstitutionSource;
  reviewStatus: ReviewStatus;
  capability: InstitutionCapability;
  contactChannels: number;
  /** Public map position, when known (admin map). */
  location?: { latitude: number; longitude: number } | null;
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
  externalRefs: { ref: string; url: string | null }[];
  capabilitySource: string;
  review: { status: ReviewStatus; reviewedAt: string | null; note: string | null };
  discoveredAt: string | null;
  lastSeenAt: string | null;
  channels: ContactChannelView[];
  openRequests: { publicRequestId: string; status: RequestStatus; bloodGroup: BloodGroup; acknowledgedAt: string | null }[];
}

export interface OperationsOverview {
  whatsapp: WhatsAppStatusResponse;
  settings: { botEnabled: boolean; alertsPaused: boolean; updatedAt: string | null };
  ai: { provider: "none" | "gemini" | "openai" | "anthropic"; model: string | null };
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

export interface ContactChannelView {
  id: string;
  type: ChannelType;
  value: string;
  status: ChannelStatus;
  source: string;
  sourceUrl: string | null;
  retrievedAt: string;
}

export interface OutreachView {
  id: string;
  institutionId: string;
  name: string;
  capability: InstitutionCapability;
  source: InstitutionSource;
  verificationStatus: InstitutionStatus;
  reviewStatus: ReviewStatus;
  distanceKm: number | null;
  status: OutreachStatus;
  channels: ContactChannelView[];
  deliveries: { channel: "email" | "whatsapp"; target: string; status: string; failureCode: string | null; sentAt: string | null }[];
  response: { status: InstitutionResponse; at: string; source: string; contactName: string | null; contactPhone: string | null; note: string | null } | null;
  followUp: string;
}
