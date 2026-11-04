import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

export const AUDIT_ACTIONS = [
  "auth.otp.requested",
  "auth.otp.delivery_failed",
  "auth.otp.verify_failed",
  "auth.otp.locked",
  "auth.session.created",
  "auth.session.revoked",
  "auth.user.created",
  "admin.role_granted",
  "admin.role_revoked",
  "whatsapp.connect_requested",
  "whatsapp.logout_requested",
  "whatsapp.message_queued",
  "messaging.opt_out_recorded",
  "messaging.opt_out_lifted",
  "donor.registered",
  "donor.profile_updated",
  "donor.availability_changed",
  "donor.notifications_enabled",
  "donor.notifications_paused",
  "donor.notifications_resumed",
  "donor.notifications_opted_out",
  "donor.phone_changed",
  "donor.whatsapp_onboarding_started",
  "request.created",
  "request.status_changed",
  "request.viewed_by_admin",
  "request.link_created",
  "request.link_revoked",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * `audit_logs` (DATABASE_SCHEMA.md §8). Append-only. Never store OTPs, tokens,
 * full phone numbers or IP addresses here.
 */
const auditLogSchema = new Schema(
  {
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    outcome: { type: String, enum: ["success", "failure"], required: true },
    actorUserId: { type: Types.ObjectId, ref: "User" },
    resourceType: { type: String },
    resourceId: { type: String },
    requestId: { type: String, required: true },
  },
  { collection: "audit_logs", timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc>) ?? model<AuditLogDoc>("AuditLog", auditLogSchema);
