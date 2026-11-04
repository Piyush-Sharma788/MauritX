import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `contact_access_logs` (ContactSharingLog): every time a donor's contact
 * details are disclosed or shared, by whom and through which link.
 * Append-only; the contact itself is never stored here.
 */
const contactAccessLogSchema = new Schema(
  {
    requestId: { type: Types.ObjectId, ref: "EmergencyRequest", required: true },
    responseId: { type: Types.ObjectId, ref: "RequestResponse" },
    donorUserId: { type: Types.ObjectId, ref: "User" },
    action: { type: String, enum: ["revealed", "sent_by_whatsapp", "share_link_created", "share_link_viewed", "share_link_revoked"], required: true },
    via: { type: String, enum: ["manage_link", "donor_contacts_link", "whatsapp", "admin"], required: true },
    linkId: { type: Types.ObjectId, ref: "RequestShareLink" },
    actorUserId: { type: Types.ObjectId, ref: "User" },
    at: { type: Date, required: true },
  },
  { collection: "contact_access_logs", strict: "throw", versionKey: false },
);

contactAccessLogSchema.index({ requestId: 1, at: -1 });
contactAccessLogSchema.index({ donorUserId: 1, at: -1 });

export type ContactAccessLogDoc = InferSchemaType<typeof contactAccessLogSchema>;

export const ContactAccessLog: Model<ContactAccessLogDoc> =
  (models.ContactAccessLog as Model<ContactAccessLogDoc>) ?? model<ContactAccessLogDoc>("ContactAccessLog", contactAccessLogSchema);
