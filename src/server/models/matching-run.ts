import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

const candidateSchema = new Schema(
  {
    donorUserId: { type: Types.ObjectId, ref: "User", required: true },
    rank: { type: Number, required: true },
    // Straight-line distance; null when the donor or request has no coordinates.
    distanceKm: { type: Number },
    basis: { type: String, enum: ["distance", "same_city"], required: true },
    reasons: { type: [String], default: [] },
  },
  { _id: false },
);

/**
 * `matching_runs` (the MatchingResult responsibility): one deterministic,
 * explainable donor search for a request, with the policy version used,
 * the ranked candidates (user IDs only, no contact details) and how many
 * donors each rule excluded. Alerts are sent from a run, in rank order.
 */
const matchingRunSchema = new Schema(
  {
    requestId: { type: Types.ObjectId, ref: "EmergencyRequest", required: true },
    radiusKm: { type: Number, required: true },
    policyVersion: { type: String, required: true },
    policyReviewStatus: { type: String, required: true },
    basis: { type: String, enum: ["distance", "city"], required: true },
    eligibleGroups: { type: [String], default: [] },
    candidates: { type: [candidateSchema], default: [] },
    excluded: { type: Map, of: Number, default: {} },
    scanned: { type: Number, required: true },
    // Absent when the run came from automated coordination.
    createdBy: { type: Types.ObjectId, ref: "User" },
    trigger: { type: String, enum: ["admin", "automatic"], required: true, default: "admin" },
  },
  { collection: "matching_runs", timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

matchingRunSchema.index({ requestId: 1, createdAt: -1 });

export type MatchingRunDoc = InferSchemaType<typeof matchingRunSchema>;

export const MatchingRun: Model<MatchingRunDoc> =
  (models.MatchingRun as Model<MatchingRunDoc>) ?? model<MatchingRunDoc>("MatchingRun", matchingRunSchema);
