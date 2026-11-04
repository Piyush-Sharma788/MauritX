import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

export const COORDINATION_EVENT_TYPES = [
  "automation_started",
  "automation_paused",
  "automation_resumed",
  "automation_cancelled",
  "discovery_completed",
  "discovery_failed",
  "outreach_sent",
  "institution_responded",
  "donor_wave_sent",
  "donor_zone_expanded",
  "donor_target_reached",
  "donors_exhausted",
  "donor_interested",
  "donor_contact_shared",
  "requester_notified",
  "request_closed",
] as const;
export type CoordinationEventType = (typeof COORDINATION_EVENT_TYPES)[number];

/**
 * `coordination_events` (EmergencyCoordination history): what happened for a
 * request, in order. `visibleToRequester` events are shown on the manage link,
 * written for the family; details never include donor or patient identities.
 */
const coordinationEventSchema = new Schema(
  {
    requestId: { type: Types.ObjectId, ref: "EmergencyRequest", required: true },
    type: { type: String, enum: COORDINATION_EVENT_TYPES, required: true },
    summary: { type: String, required: true, maxlength: 300 },
    visibleToRequester: { type: Boolean, required: true, default: false },
    actor: { type: String, enum: ["system", "admin", "donor", "institution", "requester"], required: true },
    actorUserId: { type: Types.ObjectId, ref: "User" },
    at: { type: Date, required: true },
  },
  { collection: "coordination_events", strict: "throw", versionKey: false },
);

coordinationEventSchema.index({ requestId: 1, at: -1 });

export type CoordinationEventDoc = InferSchemaType<typeof coordinationEventSchema>;

export const CoordinationEvent: Model<CoordinationEventDoc> =
  (models.CoordinationEvent as Model<CoordinationEventDoc>) ??
  model<CoordinationEventDoc>("CoordinationEvent", coordinationEventSchema);
