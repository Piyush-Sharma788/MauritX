import type { SendOtpResponse, VerifyOtpResponse } from "@/features/auth/schemas";
import { apiRequest } from "@/lib/api/browser-client";

export type { ApiResult } from "@/lib/api/browser-client";

export const authApi = {
  sendOtp: (phone: string, channel: "whatsapp" | "sms" = "whatsapp") =>
    apiRequest<SendOtpResponse>("POST", "/api/v1/auth/otp/request", { body: { phone, purpose: "login", channel } }),
  verifyOtp: (phone: string, code: string) => apiRequest<VerifyOtpResponse>("POST", "/api/v1/auth/otp/verify", { body: { phone, code } }),
  startMfa: () => apiRequest<{ secret: string; otpauthUri: string; qrSvg: string }>("POST", "/api/v1/auth/mfa/enroll"),
  confirmMfa: (code: string) => apiRequest<{ recoveryCodes: string[] }>("POST", "/api/v1/auth/mfa/enroll/confirm", { body: { code } }),
  verifyMfa: (input: { code: string } | { recoveryCode: string }) =>
    apiRequest<{ recoveryCodesRemaining: number }>("POST", "/api/v1/auth/mfa/verify", { body: input }),
  requestDeletionOtp: () => apiRequest<SendOtpResponse>("POST", "/api/v1/account/deletion/otp"),
  deleteAccount: (code: string) => apiRequest<{ deleted: true }>("POST", "/api/v1/account/deletion", { body: { code, confirm: "DELETE" } }),
  logout: () => apiRequest<{ signedOut: true }>("POST", "/api/v1/auth/logout"),
};
