import type { ChannelStatus, ChannelType, ContactRole, ContactStatus, CoordinationStatus, InstitutionResponse, InstitutionStatus, RadiusKm } from "@/features/coordination/schemas";
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
  automation: (publicRequestId: string, action: "pause" | "resume" | "cancel" | "run_wave_now" | "rediscover" | "start") =>
    apiRequest<{ action: string }>("POST", `${ADMIN}/requests/${publicRequestId}/automation`, { body: { action } }),
  outreach: (publicRequestId: string, outreachId: string, body: { action: "retry" | "send" | "cancel" } | { action: "record_response"; response: InstitutionResponse; note?: string }) =>
    apiRequest<{ action: string }>("POST", `${ADMIN}/requests/${publicRequestId}/outreach/${outreachId}`, { body }),
  reviewInstitution: (id: string, status: "approved" | "excluded", note?: string) => apiRequest<{ status: string }>("POST", `${ADMIN}/institutions/${id}/review`, { body: { status, ...(note ? { note } : {}) } }),
  addChannel: (id: string, body: { type: ChannelType; value: string; status: ChannelStatus }) => apiRequest<{ added: true }>("POST", `${ADMIN}/institutions/${id}/channels`, { body }),
  updateChannel: (id: string, channelId: string, body: { type: ChannelType; value: string; status: ChannelStatus }) => apiRequest<{ updated: true }>("PATCH", `${ADMIN}/institutions/${id}/channels/${channelId}`, { body }),
  setChannelStatus: (id: string, channelId: string, status: ChannelStatus) => apiRequest<{ status: ChannelStatus }>("POST", `${ADMIN}/institutions/${id}/channels/${channelId}/status`, { body: { status } }),
  retryJob: (jobId: string) => apiRequest<{ status: "queued" }>("POST", `${ADMIN}/jobs/${jobId}/retry`),
};
