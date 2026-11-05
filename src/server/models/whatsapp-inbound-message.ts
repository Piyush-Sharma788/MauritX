import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `whatsapp_inbound_messages`: provider message IDs already processed, so a
 * redelivered or replayed message is never handled twice. No content is stored.
 */
const whatsAppInboundMessageSchema = new Schema(
  {
    providerMessageId: { type: String, required: true },
    // Keyed hash of the sender: their latest message opens the Cloud API's 24-hour reply window.
    phoneLookup: { type: String },
    receivedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: "whatsapp_inbound_messages", versionKey: false, strict: "throw" },
);

whatsAppInboundMessageSchema.index({ providerMessageId: 1 }, { unique: true });
whatsAppInboundMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
whatsAppInboundMessageSchema.index({ phoneLookup: 1, receivedAt: -1 }, { sparse: true });

export type WhatsAppInboundMessageDoc = InferSchemaType<typeof whatsAppInboundMessageSchema>;

export const WhatsAppInboundMessage: Model<WhatsAppInboundMessageDoc> =
  (models.WhatsAppInboundMessage as Model<WhatsAppInboundMessageDoc>) ??
  model<WhatsAppInboundMessageDoc>("WhatsAppInboundMessage", whatsAppInboundMessageSchema);
