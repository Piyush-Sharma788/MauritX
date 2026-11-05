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
  "request.created_via_whatsapp",
  "request.institution_linked",
  "request.institution_acknowledged",
  "matching.run_created",
  "alerts.batch_queued",
  "alerts.message_retried",
  "response.recorded",
  "response.coordination_updated",
  "institution.created",
  "institution.status_changed",
  "institution.contact_added",
  "institution.contact_status_changed",
  "institution.availability_reported",
  "institution.access_denied",
  "settings.bot_enabled_changed",
  "settings.alerts_paused_changed",
  "conversations.viewed_by_admin",
  "ai.action_proposed",
  "automation.started",
  "automation.changed",
  "discovery.completed",
  "discovery.failed",
  "institution.reviewed",
  "institution.channel_changed",
  "outreach.queued",
  "outreach.sent",
  "outreach.failed",
  "outreach.response_recorded",
  "outreach.email_unsubscribed",
  "outreach.changed",
  "donor_contact.revealed",
  "donor_contact.link_created",
  "donor_contact.link_viewed",
  "donor_contact.marked_contacted",
  "donor_contact.viewed_by_admin",
  "jobs.retried",
  "auth.mfa.enrollment_started",
  "auth.mfa.enrolled",
  "auth.mfa.verified",
  "auth.mfa.failed",
  "auth.mfa.recovery_code_used",
  "auth.mfa.reset",
  "account.deletion_requested",
  "account.deleted",
  "retention.requests_anonymized",
  "admin.role_changed",
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
