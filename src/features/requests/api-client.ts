import type { AdminRequestDetail, CreateRequestResponse, DonorContactView, TrackedRequestView } from "@/features/requests/types";
import type { RequestStatus } from "@/features/requests/schemas";
import { apiRequest } from "@/lib/api/browser-client";

const BASE = "/api/v1/requests";
const tokenHeader = (token: string) => ({ "X-Tracking-Token": token });

export const requestApi = {
  create: (payload: Record<string, unknown>, idempotencyKey: string) =>
    apiRequest<CreateRequestResponse>("POST", BASE, { body: payload, headers: { "Idempotency-Key": idempotencyKey } }),
  setStatus: (token: string, id: string, status: "partially_fulfilled" | "fulfilled" | "cancelled") =>
    status === "cancelled"
      ? apiRequest<TrackedRequestView>("POST", `${BASE}/${id}/cancel`, { headers: tokenHeader(token) })
      : apiRequest<TrackedRequestView>("POST", `${BASE}/${id}/status`, { body: { status }, headers: tokenHeader(token) }),
  createFamilyLink: (token: string, id: string, hours: 24 | 72 | 168) =>
    apiRequest<{ id: string; url: string; expiresAt: string }>("POST", `${BASE}/${id}/share-links`, { body: { hours }, headers: tokenHeader(token) }),
  revokeFamilyLink: (token: string, id: string, linkId: string) =>
    apiRequest<{ revoked: true }>("DELETE", `${BASE}/${id}/share-links/${linkId}`, { headers: tokenHeader(token) }),
  revealDonor: (token: string, id: string, responseId: string) =>
    apiRequest<DonorContactView>("POST", `${BASE}/${id}/donors/${responseId}/reveal`, { headers: tokenHeader(token) }),
  markDonorContacted: (token: string, id: string, responseId: string) =>
    apiRequest<{ contacted: true }>("POST", `${BASE}/${id}/donors/${responseId}/contacted`, { headers: tokenHeader(token) }),
  createContactLink: (token: string, id: string, hours: 6 | 24 | 72) =>
    apiRequest<{ id: string; url: string; expiresAt: string }>("POST", `${BASE}/${id}/contact-links`, { body: { hours }, headers: tokenHeader(token) }),
};

export const adminRequestApi = {
  detail: (id: string) => apiRequest<AdminRequestDetail>("GET", `/api/v1/admin/requests/${id}`),
  setStatus: (id: string, status: RequestStatus, note?: string) =>
    apiRequest<{ status: RequestStatus }>("POST", `/api/v1/admin/requests/${id}/status`, { body: { status, ...(note ? { note } : {}) } }),
  revokeLink: (id: string, linkId: string) => apiRequest<{ revoked: true }>("DELETE", `/api/v1/admin/requests/${id}/share-links/${linkId}`),
};
