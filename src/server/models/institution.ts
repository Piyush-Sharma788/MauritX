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

/** Where a stored value may come from. `ai_extracted` values are always unverified suggestions. */
export const STORED_CHANNEL_SOURCES = [...CHANNEL_SOURCES, "ai_extracted"] as const;
export const VALIDATION_STATES = ["valid", "invalid", "unknown"] as const;
export const CAPABILITY_SOURCES = ["admin", "source_tags", "name", "official_website", "ai_extracted"] as const;
export const PROVENANCE_FIELDS = ["name", "address", "openingHours", "capability"] as const;
export const PROVENANCE_SOURCES = ["admin", "openstreetmap", "official_website", "ai_extracted"] as const;

/** Automated, explainable check of a contact value (DNS for email domains, reachability for websites). */
const validationSchema = new Schema(
  {
    state: { type: String, enum: VALIDATION_STATES, required: true },
    reason: { type: String, maxlength: 120 },
    checkedAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * One way to reach an institution, with where it came from and when. Values
 * are institutional (switchboard, official email, website), never a person's.
 * `status` is the admin-controlled lifecycle; `lastSeenAt`/`staleSince` track
 * whether the source still publishes it, and `validation` the automatic checks.
 */
const contactChannelSchema = new Schema(
  {
    type: { type: String, enum: CHANNEL_TYPES, required: true },
    value: { type: String, required: true, maxlength: 300 },
    source: { type: String, enum: STORED_CHANNEL_SOURCES, required: true },
    sourceUrl: { type: String, maxlength: 500 },
    retrievedAt: { type: Date, required: true },
    status: { type: String, enum: CHANNEL_STATUSES, required: true, default: "unverified" },
    statusChangedAt: { type: Date },
    statusChangedBy: { type: Types.ObjectId, ref: "User" },
    // Last time a source run still published this value; set when it stops (never deleted).
    lastSeenAt: { type: Date },
    staleSince: { type: Date },
    // AI-extracted values only: the model's confidence, 0..1.
    confidence: { type: Number, min: 0, max: 1 },
    validation: { type: validationSchema },
  },
  { _id: true },
);

/**
 * Field-level provenance for values that came from a source (name, address,
 * opening hours, capability). When a source reports a different value for a
 * field an admin owns, it is kept here as `pendingValue` instead of overwriting.
 */
const fieldSourceSchema = new Schema(
  {
    field: { type: String, enum: PROVENANCE_FIELDS, required: true },
    value: { type: String, maxlength: 300 },
    source: { type: String, enum: PROVENANCE_SOURCES, required: true },
    sourceUrl: { type: String, maxlength: 500 },
    retrievedAt: { type: Date, required: true },
    lastSeenAt: { type: Date },
    confidence: { type: Number, min: 0, max: 1 },
    pendingValue: { type: String, maxlength: 300 },
  },
  { _id: false },
);

/** One record in an external source that was merged into this institution. */
const sourceRecordSchema = new Schema(
  {
    ref: { type: String, required: true, maxlength: 120 },
    provider: { type: String, enum: ["openstreetmap"], required: true },
    url: { type: String, maxlength: 500 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    staleSince: { type: Date },
  },
  { _id: false },
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
    capabilitySource: { type: String, enum: CAPABILITY_SOURCES, required: true, default: "admin" },
    contactChannels: { type: [contactChannelSchema], default: [] },
    review: {
      status: { type: String, enum: REVIEW_STATUSES, required: true, default: "approved" },
      reviewedAt: { type: Date },
      reviewedBy: { type: Types.ObjectId, ref: "User" },
      note: { type: String, maxlength: 300 },
    },
    discoveredAt: { type: Date },
    lastSeenAt: { type: Date },
    // Set when no source publishes this place any more (area refresh); stale records are kept, not deleted.
    staleSince: { type: Date },
    openingHours: { type: String, maxlength: 300 },
    sourceRecords: { type: [sourceRecordSchema], default: [] },
    fieldSources: { type: [fieldSourceSchema], default: [] },
    // A duplicate that was merged into another institution; it stays only so old references resolve.
    mergedInto: { type: Types.ObjectId, ref: "Institution" },
    mergedAt: { type: Date },
    // Last time contacts on this record were validated / its website read.
    validatedAt: { type: Date },
    enrichedAt: { type: Date },
  },
  { collection: "institutions", timestamps: true, strict: "throw" },
);

institutionSchema.index({ type: 1, verificationStatus: 1 });
institutionSchema.index({ cityNormalized: 1, verificationStatus: 1 });
institutionSchema.index({ location: "2dsphere" }, { sparse: true });
institutionSchema.index({ externalRefs: 1 }, { unique: true, partialFilterExpression: { "externalRefs.0": { $exists: true } } });
institutionSchema.index({ "review.status": 1, source: 1 });
institutionSchema.index({ mergedInto: 1 }, { sparse: true });

export type InstitutionDoc = InferSchemaType<typeof institutionSchema>;

export const Institution: Model<InstitutionDoc> =
  (models.Institution as Model<InstitutionDoc>) ?? model<InstitutionDoc>("Institution", institutionSchema);
