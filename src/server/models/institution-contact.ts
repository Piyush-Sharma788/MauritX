import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { CONTACT_ROLES, CONTACT_STATUSES } from "@/features/coordination/schemas";

/**
 * `institution_contacts`: staff numbers linked to an institution by an admin.
 * A number gets institutional privileges only while this record is verified
 * AND its institution is verified; the WhatsApp number alone grants nothing.
 * One institutional role per number.
 */
const institutionContactSchema = new Schema(
  {
    institutionId: { type: Types.ObjectId, ref: "Institution", required: true },
    nameEncrypted: { type: String, required: true },
    phoneLookup: { type: String, required: true },
    phoneEncrypted: { type: String, required: true },
    // Coordinators can also confirm fulfilment; staff can view, acknowledge and report availability.
    role: { type: String, enum: CONTACT_ROLES, required: true },
    status: { type: String, enum: CONTACT_STATUSES, required: true, default: "pending" },
    verifiedAt: { type: Date },
    verifiedBy: { type: Types.ObjectId, ref: "User" },
    revokedAt: { type: Date },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
  },
  { collection: "institution_contacts", timestamps: true, strict: "throw" },
);

institutionContactSchema.index({ phoneLookup: 1 }, { unique: true });
institutionContactSchema.index({ institutionId: 1, status: 1 });

export type InstitutionContactDoc = InferSchemaType<typeof institutionContactSchema>;

export const InstitutionContact: Model<InstitutionContactDoc> =
  (models.InstitutionContact as Model<InstitutionContactDoc>) ??
  model<InstitutionContactDoc>("InstitutionContact", institutionContactSchema);
