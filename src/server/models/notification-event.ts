import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";
import { MESSAGE_KINDS, MESSAGE_STATUSES } from "@/features/whatsapp/types";

/**
 * `notification_events` (DATABASE_SCHEMA.md §6), also used as the outbox the
 * WhatsApp worker drains. The message body is encrypted and erased once the
 * message reaches a final state; the phone number is stored encrypted plus a
 * keyed lookup token.
 */
const notificationEventSchema = new Schema(
  {
    channel: { type: String, enum: ["whatsapp", "sms"], required: true, default: "whatsapp" },
    provider: { type: String, enum: ["whatsapp_web", "whatsapp_cloud"], required: true },
    kind: { type: String, enum: MESSAGE_KINDS, required: true },
    templateName: { type: String, required: true },
    requestId: { type: String },
    // The donor search an emergency alert came from.
    matchingRunId: { type: Types.ObjectId, ref: "MatchingRun" },
    recipientUserId: { type: Types.ObjectId, ref: "User" },
    recipientLookup: { type: String, required: true },
    recipientPhoneEncrypted: { type: String, required: true },
    bodyEncrypted: { type: String },
    // Cloud API template values, encrypted and erased with the body.
    templateParamsEncrypted: { type: String },
    status: { type: String, enum: MESSAGE_STATUSES, required: true, default: "queued" },
    failureCode: { type: String },
    providerMessageId: { type: String },
    idempotencyKey: { type: String, required: true },
    requestedBy: { type: Types.ObjectId, ref: "User" },
    // 0 = conversational reply, 1 = proactive message.
    priority: { type: Number, required: true, default: 1 },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: { type: Date },
    expiresAt: { type: Date, required: true },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    failedAt: { type: Date },
  },
  { collection: "notification_events", timestamps: true, strict: "throw" },
);

notificationEventSchema.index({ idempotencyKey: 1 }, { unique: true });
notificationEventSchema.index({ providerMessageId: 1 }, { sparse: true });
notificationEventSchema.index({ status: 1, priority: 1, nextAttemptAt: 1, createdAt: 1 });
notificationEventSchema.index({ recipientUserId: 1, kind: 1, createdAt: -1 });
notificationEventSchema.index({ sentAt: -1 });
notificationEventSchema.index({ createdAt: -1 });
notificationEventSchema.index({ recipientLookup: 1, status: 1 });
notificationEventSchema.index({ requestId: 1, kind: 1, status: 1 }, { sparse: true });
notificationEventSchema.index({ recipientLookup: 1, kind: 1, createdAt: -1 });

export type NotificationEventDoc = InferSchemaType<typeof notificationEventSchema>;

export const NotificationEvent: Model<NotificationEventDoc> =
  (models.NotificationEvent as Model<NotificationEventDoc>) ??
  model<NotificationEventDoc>("NotificationEvent", notificationEventSchema);
