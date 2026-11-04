import type { ChannelStatus, InstitutionStatus, OutreachStatus, ReviewStatus } from "@/features/coordination/schemas";

/**
 * Which channels may be used to contact one institution, and if none, why.
 * Pure and deterministic.
 * - Excluded, rejected or suspended institutions are never contacted.
 * - An email address is used when an admin verified it, or when it is
 *   unverified but the institution was approved in review (or the operator
 *   chose OUTREACH_INCLUDE_UNREVIEWED). Invalid and opted-out addresses never.
 * - WhatsApp only to verified contacts of a verified institution (Phase 5).
 * - Phone numbers are shown to coordinators for calling; nothing dials them.
 */

export interface PlanInput {
  verificationStatus: InstitutionStatus;
  reviewStatus: ReviewStatus;
  channels: { id: string; type: "email" | "phone" | "website"; value: string; status: ChannelStatus }[];
  verifiedWhatsAppContacts: number;
  emailConfigured: boolean;
  includeUnreviewed: boolean;
}

export interface OutreachPlan {
  status: OutreachStatus;
  emails: { id: string; value: string }[];
  whatsapp: boolean;
}

export function planOutreach(input: PlanInput): OutreachPlan {
  if (input.reviewStatus === "excluded" || input.verificationStatus === "rejected" || input.verificationStatus === "suspended") {
    return { status: "excluded", emails: [], whatsapp: false };
  }
  const trusted = input.reviewStatus === "approved" || input.includeUnreviewed;
  const usable = input.channels.filter((c) => c.type === "email" && (c.status === "verified" || (c.status === "unverified" && trusted)));
  const pendingReview = input.channels.some((c) => c.type === "email" && c.status === "unverified") && !trusted;
  const whatsapp = input.verificationStatus === "verified" && input.verifiedWhatsAppContacts > 0;
  const emails = input.emailConfigured ? usable.map((c) => ({ id: c.id, value: c.value })) : [];

  if (emails.length || whatsapp) return { status: "queued", emails, whatsapp };
  if (usable.length && !input.emailConfigured) return { status: "channel_unavailable", emails: [], whatsapp: false };
  if (pendingReview) return { status: "awaiting_review", emails: [], whatsapp: false };
  return { status: "no_contact", emails: [], whatsapp: false };
}
