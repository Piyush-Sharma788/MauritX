import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

export const CONVERSATION_STATUSES = ["active", "completed", "cancelled"] as const;
export const CONVERSATION_FLOWS = ["donor_onboarding", "donor_update", "emergency_request", "request_cancel", "donor_response"] as const;
export type ConversationFlowName = (typeof CONVERSATION_FLOWS)[number];

/**
 * `whatsapp_conversations`: saved progress of a WhatsApp bot flow (donor
 * registration or UPDATE, an emergency request, a cancellation, or a donor's
 * reply to an alert), one active flow per phone number. Answers are stored encrypted (`dataEncrypted`).
 * `version` provides optimistic concurrency so two messages can't race.
 */
const whatsAppConversationSchema = new Schema(
  {
    phoneLookup: { type: String, required: true },
    flow: { type: String, enum: CONVERSATION_FLOWS, required: true },
    status: { type: String, enum: CONVERSATION_STATUSES, required: true },
    state: { type: String, required: true },
    history: { type: [String], default: [] },
    dataEncrypted: { type: String, required: true },
    userId: { type: Types.ObjectId, ref: "User" },
    startedVia: { type: String, enum: ["whatsapp"], required: true },
    lastInboundAt: { type: Date },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
    // Inactive progress is discarded after this.
    expiresAt: { type: Date, required: true },
    version: { type: Number, required: true, default: 0 },
  },
  { collection: "whatsapp_conversations", timestamps: true, strict: "throw", versionKey: false },
);

whatsAppConversationSchema.index({ phoneLookup: 1 }, { unique: true });
whatsAppConversationSchema.index({ userId: 1 }, { sparse: true });
whatsAppConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type WhatsAppConversationDoc = InferSchemaType<typeof whatsAppConversationSchema>;

export const WhatsAppConversation: Model<WhatsAppConversationDoc> =
  (models.WhatsAppConversation as Model<WhatsAppConversationDoc>) ??
  model<WhatsAppConversationDoc>("WhatsAppConversation", whatsAppConversationSchema);
