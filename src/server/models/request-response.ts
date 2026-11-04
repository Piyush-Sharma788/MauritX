import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { COORDINATION_STATUSES, DONOR_RESPONSES } from "@/features/coordination/schemas";

const coordinationEntrySchema = new Schema(
  {
    status: { type: String, enum: COORDINATION_STATUSES, required: true },
    at: { type: Date, required: true },
    actor: { type: String, enum: ["donor", "admin", "institution"], required: true },
    actorUserId: { type: Types.ObjectId, ref: "User" },
    actorContactId: { type: Types.ObjectId, ref: "InstitutionContact" },
    note: { type: String, maxlength: 300 },
  },
  { _id: false },
);

/**
 * `request_responses` (DATABASE_SCHEMA.md §5): one donor's answer to one
 * request's alert, unique per (request, donor). `coordinationStatus` tracks
 * what happened next; only a coordinator or verified institution moves it
 * past "interested".
 */
const requestResponseSchema = new Schema(
  {
    requestId: { type: Types.ObjectId, ref: "EmergencyRequest", required: true },
    donorUserId: { type: Types.ObjectId, ref: "User", required: true },
    notificationId: { type: Types.ObjectId, ref: "NotificationEvent" },
    response: { type: String, enum: DONOR_RESPONSES, required: true },
    // Separate from alert consent: may the coordinator and hospital see this donor's name and number?
    contactSharingConsentAt: { type: Date },
    contactSharingDeclinedAt: { type: Date },
    coordinationStatus: { type: String, enum: COORDINATION_STATUSES },
    coordinationHistory: { type: [coordinationEntrySchema], default: [] },
    respondedAt: { type: Date, required: true },
  },
  { collection: "request_responses", timestamps: true, strict: "throw" },
);

requestResponseSchema.index({ requestId: 1, donorUserId: 1 }, { unique: true });
requestResponseSchema.index({ requestId: 1, createdAt: -1 });
requestResponseSchema.index({ donorUserId: 1, createdAt: -1 });

export type RequestResponseDoc = InferSchemaType<typeof requestResponseSchema>;

export const RequestResponse: Model<RequestResponseDoc> =
  (models.RequestResponse as Model<RequestResponseDoc>) ?? model<RequestResponseDoc>("RequestResponse", requestResponseSchema);
