import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const OTP_PURPOSES = ["login", "registration", "request_verification", "phone_change"] as const;

/** `otp_challenges` (DATABASE_SCHEMA.md §7). Only a keyed hash of the code is stored. */
const otpChallengeSchema = new Schema(
  {
    phoneLookup: { type: String, required: true },
    otpHash: { type: String, required: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { collection: "otp_challenges", timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

// MongoDB removes expired challenges automatically.
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpChallengeSchema.index({ phoneLookup: 1, createdAt: -1 });

export type OtpChallengeDoc = InferSchemaType<typeof otpChallengeSchema>;

export const OtpChallenge: Model<OtpChallengeDoc> =
  (models.OtpChallenge as Model<OtpChallengeDoc>) ?? model<OtpChallengeDoc>("OtpChallenge", otpChallengeSchema);
