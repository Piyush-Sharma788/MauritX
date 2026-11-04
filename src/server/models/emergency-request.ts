import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { BLOOD_GROUPS } from "@/features/donors/schemas";
import { COMPONENTS, PRIORITIES, REQUEST_STATUSES } from "@/features/requests/schemas";

const historyEntrySchema = new Schema(
  {
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    at: { type: Date, required: true },
    actor: { type: String, enum: ["requester", "admin", "system"], required: true },
    actorUserId: { type: Types.ObjectId, ref: "User" },
    // Internal to MarutiX admins; never shown on tracking links.
    note: { type: String, maxlength: 300 },
  },
  { _id: false },
);

/**
 * `emergency_requests` (DATABASE_SCHEMA.md §3). Patient and contact details
 * are encrypted; tracking links expose none of them. Hospital fields are
 * institutional, not personal. `location` is the requester's approximate
 * device location, not a verified hospital location.
 */
const emergencyRequestSchema = new Schema(
  {
    publicRequestId: { type: String, required: true },
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    priority: { type: String, enum: PRIORITIES, required: true },

    patientNameEncrypted: { type: String, required: true },
    patientAge: { type: Number, min: 0, max: 120 },
    contactNameEncrypted: { type: String, required: true },
    contactPhoneEncrypted: { type: String, required: true },
    contactPhoneLookup: { type: String, required: true },

    bloodGroup: { type: String, enum: BLOOD_GROUPS, required: true },
    component: { type: String, enum: COMPONENTS, required: true },
    unitsRequested: { type: Number, required: true, min: 1, max: 20 },
    requiredBy: { type: Date, required: true },

    hospitalName: { type: String, required: true, maxlength: 120 },
    hospitalAddress: { type: String, required: true, maxlength: 200 },
    city: { type: String, required: true, maxlength: 60 },
    cityNormalized: { type: String, required: true },
    locality: { type: String, required: true, maxlength: 80 },
    hospitalPhone: { type: String, maxlength: 24 },

    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined },
    },

    verifiedAt: { type: Date },
    verifiedBy: { type: Types.ObjectId, ref: "User" },
    whatsappUpdates: { type: Boolean, required: true, default: false },
    consent: {
      sharingAcceptedAt: { type: Date, required: true },
      privacyNoticeVersion: { type: String, required: true },
    },
    // Keyed hash of phone + blood group + component + hospital, to catch double submissions.
    dedupeKey: { type: String, required: true },
    history: { type: [historyEntrySchema], default: [] },
    expiresAt: { type: Date, required: true },
    closedAt: { type: Date },
  },
  { collection: "emergency_requests", timestamps: true, strict: "throw" },
);

emergencyRequestSchema.index({ publicRequestId: 1 }, { unique: true });
emergencyRequestSchema.index({ status: 1, expiresAt: 1 });
emergencyRequestSchema.index({ createdAt: -1 });
emergencyRequestSchema.index({ bloodGroup: 1, status: 1 });
emergencyRequestSchema.index({ cityNormalized: 1, status: 1 });
emergencyRequestSchema.index({ dedupeKey: 1, createdAt: -1 });
emergencyRequestSchema.index({ contactPhoneLookup: 1, status: 1 });
emergencyRequestSchema.index({ location: "2dsphere" }, { sparse: true });

export type EmergencyRequestDoc = InferSchemaType<typeof emergencyRequestSchema>;

export const EmergencyRequest: Model<EmergencyRequestDoc> =
  (models.EmergencyRequest as Model<EmergencyRequestDoc>) ?? model<EmergencyRequestDoc>("EmergencyRequest", emergencyRequestSchema);
