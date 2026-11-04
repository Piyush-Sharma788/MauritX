import type { SendOtpResponse } from "@/features/auth/schemas";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import type { DonorAlertsResponse, DonorOverview, DonorProfileView } from "@/features/donors/types";
import type { DonorProfileUpdate } from "@/features/donors/schemas";
import { apiRequest } from "@/lib/api/browser-client";

const BASE = "/api/v1/donors";

export const donorApi = {
  overview: () => apiRequest<DonorOverview>("GET", `${BASE}/me`),
  update: (patch: Partial<Record<keyof DonorProfileUpdate, unknown>>) => apiRequest<DonorProfileView>("PATCH", `${BASE}/me`, { body: patch }),
  setAvailability: (availableForRequests: boolean) =>
    apiRequest<DonorProfileView>("PATCH", `${BASE}/me/availability`, { body: { availableForRequests } }),
  enableAlerts: () =>
    apiRequest<DonorProfileView>("POST", `${BASE}/me/consents`, { body: { action: "enable", consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION } }),
  alertAction: (action: "pause" | "resume" | "opt_out") => apiRequest<DonorProfileView>("POST", `${BASE}/me/consents`, { body: { action } }),
  alerts: () => apiRequest<DonorAlertsResponse>("GET", `${BASE}/me/notifications`),
  requestPhoneOtp: (phone: string) => apiRequest<SendOtpResponse>("POST", `${BASE}/me/phone/otp`, { body: { phone } }),
  verifyPhone: (phone: string, code: string) => apiRequest<{ maskedPhone: string }>("POST", `${BASE}/me/phone/verify`, { body: { phone, code } }),
};
