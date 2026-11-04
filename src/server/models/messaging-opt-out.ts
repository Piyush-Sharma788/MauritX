import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `messaging_opt_outs`: suppression list keyed by the phone lookup token, so
 * it also covers numbers that never created an account.
 */
const messagingOptOutSchema = new Schema(
  {
    phoneLookup: { type: String, required: true },
    channel: { type: String, enum: ["whatsapp"], required: true, default: "whatsapp" },
    source: { type: String, enum: ["whatsapp_stop", "user", "admin"], required: true },
    optedOutAt: { type: Date, required: true },
  },
  { collection: "messaging_opt_outs", versionKey: false, strict: "throw" },
);

messagingOptOutSchema.index({ phoneLookup: 1, channel: 1 }, { unique: true });

export type MessagingOptOutDoc = InferSchemaType<typeof messagingOptOutSchema>;

export const MessagingOptOut: Model<MessagingOptOutDoc> =
  (models.MessagingOptOut as Model<MessagingOptOutDoc>) ??
  model<MessagingOptOutDoc>("MessagingOptOut", messagingOptOutSchema);
