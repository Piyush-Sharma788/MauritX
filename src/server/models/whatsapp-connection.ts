import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { WHATSAPP_CONNECTION_STATES } from "@/features/whatsapp/types";

/**
 * `whatsapp_connection`: one document (`_id: "primary"`) describing the
 * WhatsApp Web pilot connection. The worker writes it; the admin API reads it.
 * The lease fields guarantee a single worker owns the WhatsApp session.
 * Session credentials and QR codes are never stored here.
 */
const whatsAppConnectionSchema = new Schema(
  {
    _id: { type: String, required: true },
    state: { type: String, enum: WHATSAPP_CONNECTION_STATES, required: true, default: "disconnected" },
    busy: { type: Boolean, required: true, default: false },
    accountMaskedNumber: { type: String },
    accountPushName: { type: String },
    accountPlatform: { type: String },
    lastReadyAt: { type: Date },
    lastDisconnectedAt: { type: Date },
    lastDisconnectReason: { type: String },
    lastError: { type: String },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date },
    heartbeatAt: { type: Date },
  },
  { collection: "whatsapp_connection", timestamps: { createdAt: false, updatedAt: true }, strict: "throw" },
);

export type WhatsAppConnectionDoc = InferSchemaType<typeof whatsAppConnectionSchema>;

export const WhatsAppConnection: Model<WhatsAppConnectionDoc> =
  (models.WhatsAppConnection as Model<WhatsAppConnectionDoc>) ??
  model<WhatsAppConnectionDoc>("WhatsAppConnection", whatsAppConnectionSchema);
