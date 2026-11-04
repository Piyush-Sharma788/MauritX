import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `consent_records` (DATABASE_SCHEMA.md §8). Append-only evidence of every
 * consent decision: who, what purpose, which channel, which notice version,
 * what they did and when. Current state lives on the donor profile.
 */
const consentRecordSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    purpose: { type: String, enum: ["donor_alerts"], required: true },
    channel: { type: String, enum: ["whatsapp"], required: true },
    action: { type: String, enum: ["granted", "paused", "resumed", "withdrawn"], required: true },
    source: { type: String, enum: ["web", "whatsapp"], required: true },
    noticeVersion: { type: String, required: true },
  },
  { collection: "consent_records", timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

consentRecordSchema.index({ userId: 1, createdAt: -1 });

export type ConsentRecordDoc = InferSchemaType<typeof consentRecordSchema>;

export const ConsentRecord: Model<ConsentRecordDoc> =
  (models.ConsentRecord as Model<ConsentRecordDoc>) ?? model<ConsentRecordDoc>("ConsentRecord", consentRecordSchema);
