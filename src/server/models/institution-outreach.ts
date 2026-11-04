import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { INSTITUTION_RESPONSES, OUTREACH_STATUSES } from "@/features/coordination/schemas";

/** One message to one channel of the institution (MessageDeliveryLog). */
const deliverySchema = new Schema(
  {
    channel: { type: String, enum: ["email", "whatsapp"], required: true },
    // Email address (institutional), or the WhatsApp outbox message ID.
    target: { type: String, required: true, maxlength: 300 },
    contactChannelId: { type: Types.ObjectId },
    notificationEventId: { type: Types.ObjectId, ref: "NotificationEvent" },
    status: { type: String, enum: ["queued", "sending", "sent", "failed", "suppressed"], required: true },
    subject: { type: String, maxlength: 300 },
    // Encrypted until sent, then erased (like the WhatsApp outbox).
    bodyEncrypted: { type: String },
    attempts: { type: Number, required: true, default: 0 },
    providerMessageId: { type: String },
    failureCode: { type: String, maxlength: 60 },
    queuedAt: { type: Date, required: true },
    sentAt: { type: Date },
    failedAt: { type: Date },
  },
  { _id: true },
);

/**
 * `institution_outreach` (InstitutionalOutreach): one institution's part in
 * one request, from discovery to its answer. Unique per (request, institution).
 * Delivery and response are separate: a sent email says nothing about blood.
 */
const institutionOutreachSchema = new Schema(
  {
    requestId: { type: Types.ObjectId, ref: "EmergencyRequest", required: true },
    institutionId: { type: Types.ObjectId, ref: "Institution", required: true },
    rank: { type: Number, required: true },
    distanceKm: { type: Number },
    status: { type: String, enum: OUTREACH_STATUSES, required: true },
    deliveries: { type: [deliverySchema], default: [] },
    // Keyed hash of the secure response-link token; the token itself is only in the message.
    responseTokenHash: { type: String },
    responseTokenExpiresAt: { type: Date },
    response: {
      status: { type: String, enum: INSTITUTION_RESPONSES },
      at: { type: Date },
      source: { type: String, enum: ["secure_link", "whatsapp", "admin"] },
      contactNameEncrypted: { type: String },
      contactPhoneEncrypted: { type: String },
      note: { type: String, maxlength: 500 },
      recordedBy: { type: Types.ObjectId, ref: "User" },
    },
    followUp: {
      status: { type: String, enum: ["none", "needed", "done"], required: true, default: "none" },
      at: { type: Date },
    },
    discoveredAt: { type: Date, required: true },
  },
  { collection: "institution_outreach", timestamps: true, strict: "throw" },
);

institutionOutreachSchema.index({ requestId: 1, institutionId: 1 }, { unique: true });
institutionOutreachSchema.index({ requestId: 1, rank: 1 });
institutionOutreachSchema.index({ institutionId: 1, createdAt: -1 });
institutionOutreachSchema.index({ responseTokenHash: 1 }, { unique: true, sparse: true });
institutionOutreachSchema.index({ status: 1, updatedAt: -1 });

export type InstitutionOutreachDoc = InferSchemaType<typeof institutionOutreachSchema>;

export const InstitutionOutreach: Model<InstitutionOutreachDoc> =
  (models.InstitutionOutreach as Model<InstitutionOutreachDoc>) ??
  model<InstitutionOutreachDoc>("InstitutionOutreach", institutionOutreachSchema);
