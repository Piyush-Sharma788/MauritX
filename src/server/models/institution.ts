import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { INSTITUTION_STATUSES, INSTITUTION_TYPES } from "@/features/coordination/schemas";

/**
 * `institutions` (DATABASE_SCHEMA.md §4). Hospitals and blood banks, added and
 * verified by an admin. Only a verified institution's verified contacts get
 * institutional access on WhatsApp.
 */
const institutionSchema = new Schema(
  {
    type: { type: String, enum: INSTITUTION_TYPES, required: true },
    legalName: { type: String, required: true, maxlength: 120 },
    displayName: { type: String, required: true, maxlength: 80 },
    address: { type: String, required: true, maxlength: 200 },
    city: { type: String, required: true, maxlength: 60 },
    cityNormalized: { type: String, required: true },
    locality: { type: String, required: true, maxlength: 80 },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined },
    },
    publicPhone: { type: String, maxlength: 24 },
    // Sensitive; admin-only.
    licenceReferenceEncrypted: { type: String },
    verificationStatus: { type: String, enum: INSTITUTION_STATUSES, required: true, default: "pending" },
    verifiedAt: { type: Date },
    verifiedBy: { type: Types.ObjectId, ref: "User" },
    statusNote: { type: String, maxlength: 300 },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
  },
  { collection: "institutions", timestamps: true, strict: "throw" },
);

institutionSchema.index({ type: 1, verificationStatus: 1 });
institutionSchema.index({ cityNormalized: 1, verificationStatus: 1 });
institutionSchema.index({ location: "2dsphere" }, { sparse: true });

export type InstitutionDoc = InferSchemaType<typeof institutionSchema>;

export const Institution: Model<InstitutionDoc> =
  (models.Institution as Model<InstitutionDoc>) ?? model<InstitutionDoc>("Institution", institutionSchema);
