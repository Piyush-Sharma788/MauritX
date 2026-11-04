import type { SendOtpResponse, VerifyOtpResponse } from "@/features/auth/schemas";
import { apiRequest } from "@/lib/api/browser-client";

export type { ApiResult } from "@/lib/api/browser-client";

export const authApi = {
  sendOtp: (phone: string) =>
    apiRequest<SendOtpResponse>("POST", "/api/v1/auth/otp/request", { body: { phone, purpose: "login", channel: "whatsapp" } }),
  verifyOtp: (phone: string, code: string) => apiRequest<VerifyOtpResponse>("POST", "/api/v1/auth/otp/verify", { body: { phone, code } }),
  logout: () => apiRequest<{ signedOut: true }>("POST", "/api/v1/auth/logout"),
};
