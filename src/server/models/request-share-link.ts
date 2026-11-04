import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `request_share_links`: tracking links for a request. The URL carries a
 * random 256-bit token; only its keyed hash is stored. `manage` links let the
 * requester update or cancel; `view` links are read-only (family sharing).
 * Every link expires and can be revoked.
 */
const requestShareLinkSchema = new Schema(
  {
    requestId: { type: Types.ObjectId, ref: "EmergencyRequest", required: true },
    tokenHash: { type: String, required: true },
    // donor_contacts: the requester shares consenting donors' contact details with one
    // responsible person (family member, hospital coordinator). Short-lived; every view is logged.
    scope: { type: String, enum: ["manage", "view", "donor_contacts"], required: true },
    createdBy: { type: String, enum: ["requester", "admin", "system"], required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { collection: "request_share_links", timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

requestShareLinkSchema.index({ tokenHash: 1 }, { unique: true });
requestShareLinkSchema.index({ requestId: 1, createdAt: -1 });

export type RequestShareLinkDoc = InferSchemaType<typeof requestShareLinkSchema>;

export const RequestShareLink: Model<RequestShareLinkDoc> =
  (models.RequestShareLink as Model<RequestShareLinkDoc>) ?? model<RequestShareLinkDoc>("RequestShareLink", requestShareLinkSchema);
