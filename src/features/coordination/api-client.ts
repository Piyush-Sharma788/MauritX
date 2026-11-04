import type { ContactRole, ContactStatus, CoordinationStatus, InstitutionStatus, RadiusKm } from "@/features/coordination/schemas";
import type { AlertBatchResult, InstitutionSummary, MatchingRunView } from "@/features/coordination/types";
import { apiRequest } from "@/lib/api/browser-client";

const ADMIN = "/api/v1/admin";

export const coordinationApi = {
  setSettings: (patch: { botEnabled?: boolean; alertsPaused?: boolean }) => apiRequest<{ botEnabled: boolean; alertsPaused: boolean }>("PATCH", `${ADMIN}/operations/settings`, { body: patch }),
  retryMessage: (messageId: string) => apiRequest<{ status: "queued" }>("POST", `${ADMIN}/messages/${messageId}/retry`),
  runMatching: (publicRequestId: string, radiusKm: RadiusKm) => apiRequest<MatchingRunView>("POST", `${ADMIN}/requests/${publicRequestId}/matching`, { body: { radiusKm } }),
  sendBatch: (publicRequestId: string, matchingRunId: string) => apiRequest<AlertBatchResult>("POST", `${ADMIN}/requests/${publicRequestId}/alerts`, { body: { matchingRunId } }),
  linkInstitution: (publicRequestId: string, institutionId: string | null) => apiRequest<{ institutionId: string | null }>("POST", `${ADMIN}/requests/${publicRequestId}/institution`, { body: { institutionId } }),
  updateResponse: (publicRequestId: string, responseId: string, status: CoordinationStatus, note?: string) =>
    apiRequest<{ status: CoordinationStatus }>("POST", `${ADMIN}/requests/${publicRequestId}/responses/${responseId}/status`, { body: { status, ...(note ? { note } : {}) } }),
  createInstitution: (body: Record<string, unknown>) => apiRequest<InstitutionSummary>("POST", `${ADMIN}/institutions`, { body }),
  setInstitutionStatus: (id: string, verificationStatus: InstitutionStatus, note?: string) =>
    apiRequest<{ verificationStatus: InstitutionStatus }>("POST", `${ADMIN}/institutions/${id}/status`, { body: { verificationStatus, ...(note ? { note } : {}) } }),
  addContact: (id: string, body: { name: string; phone: string; role: ContactRole }) => apiRequest<{ status: "pending" }>("POST", `${ADMIN}/institutions/${id}/contacts`, { body }),
  setContactStatus: (id: string, contactId: string, status: ContactStatus) => apiRequest<{ status: ContactStatus }>("POST", `${ADMIN}/institutions/${id}/contacts/${contactId}`, { body: { status } }),
};
