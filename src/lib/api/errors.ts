export type ApiErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "FORBIDDEN_ORIGIN"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "RECIPIENT_NOT_ALLOWED"
  | "RECIPIENT_OPTED_OUT"
  | "WHATSAPP_WORKER_UNAVAILABLE"
  | "WHATSAPP_QR_NOT_AVAILABLE"
  | "WHATSAPP_ONBOARDING_UNAVAILABLE"
  | "DONOR_ALREADY_REGISTERED"
  | "DONOR_NOT_REGISTERED"
  | "PHONE_IN_USE"
  | "DUPLICATE_REQUEST"
  | "INVALID_TRANSITION"
  | "TRACKING_LINK_EXPIRED"
  | "TRACKING_LINK_REVOKED"
  | "ACCOUNT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "OTP_RESEND_TOO_SOON"
  | "OTP_INVALID"
  | "OTP_EXPIRED"
  | "OTP_ATTEMPTS_EXCEEDED"
  | "OTP_DELIVERY_FAILED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** An expected, user-safe failure. Anything else is reported as INTERNAL_ERROR. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}
