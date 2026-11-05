import "server-only";
import { Types } from "mongoose";
import { OTP_LENGTH, type SendOtpResponse } from "@/features/auth/schemas";
import type { ApiContext } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { generateOtp, hashOtp, phoneLookupToken, safeEqual } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { WhatsAppApiError } from "@/lib/whatsapp/client";
import { OtpChallenge } from "@/server/models/otp-challenge";
import { getOtpDeliveryProvider, getSmsOtpOption, type OtpDeliveryProvider, type SmsOtpOption } from "@/server/otp-delivery";
import { SmsApiError } from "@/server/otp-delivery/sms";
import { recordAudit } from "@/server/services/audit";
import { enforceRateLimit, RATE_LIMITS } from "@/server/services/rate-limit";

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

type Purpose = "login" | "phone_change" | "account_deletion";

const latestChallenge = (phoneLookup: string, purpose: Purpose) =>
  OtpChallenge.findOne({ phoneLookup, purpose }).sort({ createdAt: -1 }).lean();

const DAY_SECONDS = 24 * 60 * 60;

/** Every SMS code counts against the IP, the number's daily allowance and the service-wide daily cap. */
async function enforceSmsLimits(sms: SmsOtpOption, phoneLookup: string, ip: string, now: Date) {
  await enforceRateLimit(RATE_LIMITS.otpSmsPerIp, ip, now);
  await enforceRateLimit({ scope: "otp-sms:phone", limit: sms.perPhoneDaily, windowSeconds: DAY_SECONDS }, phoneLookup, now);
  try {
    await enforceRateLimit({ scope: "otp-sms:global", limit: sms.dailyCap, windowSeconds: DAY_SECONDS }, "all", now);
  } catch (error) {
    if (error instanceof AppError) logger.error("otp.sms_daily_cap_reached", { dailyCap: sms.dailyCap });
    throw error;
  }
}

function deliveryFailureFields(error: unknown) {
  return {
    httpStatus: error instanceof WhatsAppApiError || error instanceof SmsApiError ? error.httpStatus : null,
    providerCode: error instanceof WhatsAppApiError || error instanceof SmsApiError ? error.providerCode : null,
    errorName: error instanceof Error ? error.name : "UnknownError",
  };
}

/**
 * Issues a new code. The response is identical whether or not the number
 * already has an account, so it cannot be used to enumerate users.
 *
 * Delivery: WhatsApp (or the development provider), or SMS when the user
 * asks for it. If WhatsApp fails outright and SMS is configured, the same
 * code goes by SMS instead, within the SMS limits.
 */
export async function requestOtp(
  input: { phoneE164: string; purpose: Purpose; channel?: "whatsapp" | "sms" },
  ctx: ApiContext,
  provider: OtpDeliveryProvider = getOtpDeliveryProvider(),
  sms: SmsOtpOption | null = getSmsOtpOption(),
): Promise<SendOtpResponse> {
  await connectToDatabase();
  const now = new Date();
  const phoneLookup = phoneLookupToken(input.phoneE164);
  const wantsSms = input.channel === "sms";
  if (wantsSms && !sms) throw new AppError(400, "SMS_UNAVAILABLE", "Codes by SMS aren't available. Use WhatsApp instead.");

  await enforceRateLimit(RATE_LIMITS.otpSendPerIp, ctx.ip, now);

  const previous = await latestChallenge(phoneLookup, input.purpose);
  if (previous) {
    const resendAvailableAt = new Date(previous.createdAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
    if (resendAvailableAt > now) {
      const retryAfterSeconds = Math.ceil((resendAvailableAt.getTime() - now.getTime()) / 1000);
      throw new AppError(429, "OTP_RESEND_TOO_SOON", `Please wait ${retryAfterSeconds}s before requesting a new code.`, {
        retryAfterSeconds,
        resendAvailableAt: resendAvailableAt.toISOString(),
      });
    }
  }

  await enforceRateLimit(RATE_LIMITS.otpSendPerPhone, phoneLookup, now);

  const challengeId = new Types.ObjectId();
  const code = generateOtp(OTP_LENGTH);
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);

  // Creating a new challenge supersedes older ones: verification only ever
  // considers the most recent challenge for a number.
  await OtpChallenge.create({
    _id: challengeId,
    phoneLookup,
    otpHash: hashOtp(challengeId.toString(), phoneLookup, code),
    purpose: input.purpose,
    attempts: 0,
    expiresAt,
  });

  const delivery = { phoneE164: input.phoneE164, code, expiresInMinutes: OTP_TTL_SECONDS / 60, requestId: ctx.requestId };
  const failed = async (channel: string, error: unknown) => {
    logger.warn("otp.delivery_failed", { requestId: ctx.requestId, channel, ...deliveryFailureFields(error) });
    await recordAudit({ action: "auth.otp.delivery_failed", outcome: "failure", requestId: ctx.requestId, resourceType: "otp_challenge", resourceId: challengeId.toString() });
  };
  const sendBySms = async (activeSms: SmsOtpOption) => {
    await enforceSmsLimits(activeSms, phoneLookup, ctx.ip, now);
    return activeSms.provider.send(delivery);
  };

  let used: OtpDeliveryProvider = wantsSms ? sms!.provider : provider;
  let fellBackToSms = false;
  let sent: { providerMessageId?: string };
  try {
    sent = wantsSms ? await sendBySms(sms!) : await provider.send(delivery);
  } catch (error) {
    if (error instanceof AppError) {
      await OtpChallenge.deleteOne({ _id: challengeId });
      throw error;
    }
    await failed(used.channel, error);
    if (wantsSms || !sms || provider.channel !== "whatsapp") {
      await OtpChallenge.deleteOne({ _id: challengeId });
      throw new AppError(
        503,
        "OTP_DELIVERY_FAILED",
        wantsSms ? "We couldn't send the code by SMS. Please try again in a few minutes." : "We couldn't send the code on WhatsApp. Check that this number uses WhatsApp, then try again.",
      );
    }
    try {
      sent = await sendBySms(sms);
      used = sms.provider;
      fellBackToSms = true;
    } catch (smsError) {
      await OtpChallenge.deleteOne({ _id: challengeId });
      if (!(smsError instanceof AppError)) await failed("sms", smsError);
      throw new AppError(503, "OTP_DELIVERY_FAILED", "We couldn't send the code on WhatsApp or by SMS. Please try again in a few minutes.");
    }
  }

  // Webhook statuses (WhatsApp) update this, so support can see whether the code reached the phone.
  await OtpChallenge.updateOne(
    { _id: challengeId },
    { $set: { deliveryChannel: used.channel, ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId, deliveryStatus: "accepted", deliveryUpdatedAt: new Date() } : {}) } },
  );
  if (fellBackToSms) logger.info("otp.sms_fallback_used", { requestId: ctx.requestId });

  await recordAudit({
    action: "auth.otp.requested",
    outcome: "success",
    requestId: ctx.requestId,
    resourceType: "otp_challenge",
    resourceId: challengeId.toString(),
  });

  return {
    channel: used.channel,
    fellBackToSms,
    smsAvailable: Boolean(sms),
    maskedPhone: maskPhone(input.phoneE164),
    codeLength: OTP_LENGTH,
    expiresAt: expiresAt.toISOString(),
    resendAvailableAt: new Date(now.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString(),
  };
}

const expired = () =>
  new AppError(400, "OTP_EXPIRED", "This code is no longer valid. Please request a new one.");
const locked = () =>
  new AppError(429, "OTP_ATTEMPTS_EXCEEDED", "Too many incorrect attempts. Please request a new code.");

/**
 * Verifies and consumes the latest challenge exactly once. Each guess is
 * counted atomically before comparison, so parallel guesses cannot exceed the
 * attempt limit.
 */
export async function verifyOtp(
  input: { phoneE164: string; code: string; purpose: Purpose },
  ctx: ApiContext,
): Promise<{ phoneLookup: string }> {
  await connectToDatabase();
  const now = new Date();
  const phoneLookup = phoneLookupToken(input.phoneE164);

  await enforceRateLimit(RATE_LIMITS.otpVerifyPerIp, ctx.ip, now);
  await enforceRateLimit(RATE_LIMITS.otpVerifyPerPhone, phoneLookup, now);

  const challenge = await latestChallenge(phoneLookup, input.purpose);
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) throw expired();
  if (challenge.attempts >= OTP_MAX_VERIFY_ATTEMPTS) throw locked();

  const counted = await OtpChallenge.findOneAndUpdate(
    { _id: challenge._id, consumedAt: null, expiresAt: { $gt: now }, attempts: { $lt: OTP_MAX_VERIFY_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after", lean: true },
  );
  if (!counted) throw locked();

  const matches = safeEqual(hashOtp(challenge._id.toString(), phoneLookup, input.code), challenge.otpHash);
  if (!matches) {
    const attemptsRemaining = OTP_MAX_VERIFY_ATTEMPTS - counted.attempts;
    await recordAudit({
      action: attemptsRemaining > 0 ? "auth.otp.verify_failed" : "auth.otp.locked",
      outcome: "failure",
      requestId: ctx.requestId,
      resourceType: "otp_challenge",
      resourceId: challenge._id.toString(),
    });
    if (attemptsRemaining <= 0) throw locked();
    throw new AppError(400, "OTP_INVALID", "That code doesn't match. Please check and try again.", {
      attemptsRemaining,
    });
  }

  const consumed = await OtpChallenge.updateOne(
    { _id: challenge._id, consumedAt: null },
    { $set: { consumedAt: now } },
  );
  if (consumed.modifiedCount !== 1) throw expired();

  return { phoneLookup };
}
