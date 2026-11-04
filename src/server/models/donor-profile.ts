import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { BLOOD_GROUPS } from "@/features/donors/schemas";

export { BLOOD_GROUPS };

/**
 * `donor_profiles` (DATABASE_SCHEMA.md §2). One per user. Not a clinical
 * record: blood group and last donation date are self-reported, and a
 * licensed blood centre makes every eligibility decision. The donor's name
 * lives on `users.displayName`.
 */
const donorProfileSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    bloodGroup: { type: String, enum: BLOOD_GROUPS, required: true },
    city: { type: String, required: true, maxlength: 60 },
    locality: { type: String, required: true, maxlength: 80 },
    // Approximate (≈1 km) GeoJSON point, [longitude, latitude].
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined },
    },
    locationUpdatedAt: { type: Date },
    lastDonationDate: { type: Date },
    availableForRequests: { type: Boolean, required: true, default: false },
    notificationConsentAt: { type: Date },
    notificationConsentWithdrawnAt: { type: Date },
    notificationsPausedAt: { type: Date },
    notificationChannels: { type: [String], enum: ["whatsapp"], default: [] },
    registeredVia: { type: String, enum: ["web", "whatsapp"], required: true },
    registeredAt: { type: Date, required: true },
  },
  { collection: "donor_profiles", timestamps: true, strict: "throw" },
);

donorProfileSchema.index({ userId: 1 }, { unique: true });
donorProfileSchema.index({ bloodGroup: 1, availableForRequests: 1 });
donorProfileSchema.index({ location: "2dsphere" }, { sparse: true });

export type DonorProfileDoc = InferSchemaType<typeof donorProfileSchema>;

export const DonorProfile: Model<DonorProfileDoc> =
  (models.DonorProfile as Model<DonorProfileDoc>) ?? model<DonorProfileDoc>("DonorProfile", donorProfileSchema);
