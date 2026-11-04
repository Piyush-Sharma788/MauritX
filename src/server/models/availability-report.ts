import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { AVAILABILITY_STATUSES } from "@/features/coordination/schemas";
import { BLOOD_GROUPS } from "@/features/donors/schemas";
import { COMPONENTS } from "@/features/requests/schemas";

/**
 * `institution_availability_reports`: what a verified institutional contact
 * said about stock, timestamped and attributed. Append-only. These are
 * self-reports, never shown as confirmed or live availability.
 */
const availabilityReportSchema = new Schema(
  {
    institutionId: { type: Types.ObjectId, ref: "Institution", required: true },
    contactId: { type: Types.ObjectId, ref: "InstitutionContact", required: true },
    bloodGroup: { type: String, enum: BLOOD_GROUPS.filter((g) => g !== "unknown"), required: true },
    component: { type: String, enum: COMPONENTS, required: true },
    status: { type: String, enum: AVAILABILITY_STATUSES, required: true },
    units: { type: Number, min: 0, max: 500 },
    source: { type: String, enum: ["whatsapp"], required: true },
    reportedAt: { type: Date, required: true },
  },
  { collection: "institution_availability_reports", timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

availabilityReportSchema.index({ institutionId: 1, reportedAt: -1 });

export type AvailabilityReportDoc = InferSchemaType<typeof availabilityReportSchema>;

export const AvailabilityReport: Model<AvailabilityReportDoc> =
  (models.AvailabilityReport as Model<AvailabilityReportDoc>) ??
  model<AvailabilityReportDoc>("AvailabilityReport", availabilityReportSchema);
