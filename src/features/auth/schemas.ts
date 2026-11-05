import { z } from "zod";
import { normalizeIndianMobile } from "@/lib/validation/phone";

export const OTP_LENGTH = 6;

/** Accepts common Indian formats and normalises to E.164 (+91XXXXXXXXXX). */
export const indianMobileSchema = z
  .string({ error: "Enter your mobile number." })
  .max(20, "Enter a valid 10-digit Indian mobile number.")
  .transform((value, ctx) => {
    const e164 = normalizeIndianMobile(value);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "Enter a valid 10-digit Indian mobile number." });
      return z.NEVER;
    }
    return e164;
  });

export const otpCodeSchema = z
  .string({ error: "Enter the 6-digit code." })
  .regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), "Enter the 6-digit code.");

export const sendOtpBodySchema = z.strictObject({
  phone: indianMobileSchema,
  // Phase 1 has a single sign-in flow that also creates the account on first verification.
  purpose: z.literal("login").default("login"),
  // "sms" only when the server has SMS configured (SendOtpResponse.smsAvailable).
  channel: z.enum(["whatsapp", "sms"]).default("whatsapp"),
});

export const verifyOtpBodySchema = z.strictObject({
  phone: indianMobileSchema,
  code: otpCodeSchema,
});

export type SendOtpBody = z.output<typeof sendOtpBodySchema>;
export type VerifyOtpBody = z.output<typeof verifyOtpBodySchema>;

/** Response payloads shared by the API and the browser client. */
export type OtpDeliveryChannel = "whatsapp" | "sms" | "development";

export interface SendOtpResponse {
  channel: OtpDeliveryChannel;
  maskedPhone: string;
  codeLength: number;
  expiresAt: string;
  resendAvailableAt: string;
  /** WhatsApp failed, so the code was sent by SMS instead. */
  fellBackToSms: boolean;
  /** The user may ask for the code by SMS. */
  smsAvailable: boolean;
}

export interface VerifyOtpResponse {
  user: { id: string; role: string };
  redirectTo: string;
}

export interface CurrentUserResponse {
  user: {
    id: string;
    role: string;
    status: string;
    maskedPhone: string;
    phoneVerifiedAt: string;
    createdAt: string;
  };
}
