import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import {
  CHANNEL_SOURCES,
  CHANNEL_STATUSES,
  CHANNEL_TYPES,
  INSTITUTION_CAPABILITIES,
  INSTITUTION_SOURCES,
  INSTITUTION_STATUSES,
  INSTITUTION_TYPES,
  REVIEW_STATUSES,
} from "@/features/coordination/schemas";

/**
 * One way to reach an institution, with where it came from and when. Values
 * are institutional (switchboard, official email, website), never a person's.
 */
const contactChannelSchema = new Schema(
  {
    type: { type: String, enum: CHANNEL_TYPES, required: true },
    value: { type: String, required: true, maxlength: 300 },
    source: { type: String, enum: CHANNEL_SOURCES, required: true },
    sourceUrl: { type: String, maxlength: 500 },
    retrievedAt: { type: Date, required: true },
    status: { type: String, enum: CHANNEL_STATUSES, required: true, default: "unverified" },
    statusChangedAt: { type: Date },
    statusChangedBy: { type: Types.ObjectId, ref: "User" },
  },
  { _id: true },
);

/**
 * `institutions` (DATABASE_SCHEMA.md §4). Hospitals and blood banks, either
 * added by an admin or discovered from a public source (OpenStreetMap).
 * Discovered records start as `pending` and `unreviewed`: they are never
 * verified institutions. Only a verified institution's verified contacts get
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
    // Absent for discovered records.
    createdBy: { type: Types.ObjectId, ref: "User" },
    source: { type: String, enum: INSTITUTION_SOURCES, required: true, default: "admin" },
    // Stable IDs in the source, e.g. "osm:node/6897674804". Used to deduplicate.
    externalRefs: { type: [String], default: [] },
    capability: { type: String, enum: INSTITUTION_CAPABILITIES, required: true, default: "hospital" },
    capabilitySource: { type: String, enum: ["admin", "source_tags", "name"], required: true, default: "admin" },
    contactChannels: { type: [contactChannelSchema], default: [] },
    review: {
      status: { type: String, enum: REVIEW_STATUSES, required: true, default: "approved" },
      reviewedAt: { type: Date },
      reviewedBy: { type: Types.ObjectId, ref: "User" },
      note: { type: String, maxlength: 300 },
    },
    discoveredAt: { type: Date },
    lastSeenAt: { type: Date },
  },
  { collection: "institutions", timestamps: true, strict: "throw" },
);

institutionSchema.index({ type: 1, verificationStatus: 1 });
institutionSchema.index({ cityNormalized: 1, verificationStatus: 1 });
institutionSchema.index({ location: "2dsphere" }, { sparse: true });
institutionSchema.index({ externalRefs: 1 }, { unique: true, partialFilterExpression: { "externalRefs.0": { $exists: true } } });
institutionSchema.index({ "review.status": 1, source: 1 });

export type InstitutionDoc = InferSchemaType<typeof institutionSchema>;

export const Institution: Model<InstitutionDoc> =
  (models.Institution as Model<InstitutionDoc>) ?? model<InstitutionDoc>("Institution", institutionSchema);
