import { z } from "zod";
import { indianMobileSchema } from "@/features/auth/schemas";
import { BLOOD_GROUPS, citySchema, localitySchema } from "@/features/donors/schemas";
import { COMPONENTS } from "@/features/requests/schemas";

/**
 * Coordination (matching, alerts, donor responses, institutions) validation
 * shared by the admin API, the WhatsApp bot and the admin UI. Browser-safe.
 */

/** Search radii offered to admins. */
export const RADIUS_OPTIONS_KM = [5, 10, 25, 50] as const;
export type RadiusKm = (typeof RADIUS_OPTIONS_KM)[number];

/** Requests that may be matched and alerted: verified by an admin, then activated. */
export const ALERTABLE_STATUSES = ["active", "partially_fulfilled"] as const;

/** A donor's own answer to an alert. */
export const DONOR_RESPONSES = ["interested", "unavailable", "later"] as const;
export type DonorResponse = (typeof DONOR_RESPONSES)[number];

/**
 * What happened after a donor said they're interested. Interest is not a
 * donation: only a coordinator or verified institution moves it forward, and
 * only "donation_confirmed" records an actual donation.
 */
export const COORDINATION_STATUSES = [
  "interested",
  "coordinator_contacted",
  "hospital_coordination",
  "donor_arrived",
  "donation_confirmed",
  "not_proceeding",
] as const;
export type CoordinationStatus = (typeof COORDINATION_STATUSES)[number];

export const COORDINATION_LABELS: Record<CoordinationStatus, string> = {
  interested: "Donor interested",
  coordinator_contacted: "Coordinator contacted donor",
  hospital_coordination: "Hospital coordination initiated",
  donor_arrived: "Donor arrived at the blood centre",
  donation_confirmed: "Donation confirmed",
  not_proceeding: "Not proceeding",
};

export const INSTITUTION_TYPES = ["hospital", "blood_bank"] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];
export const INSTITUTION_STATUSES = ["pending", "verified", "rejected", "suspended"] as const;
export type InstitutionStatus = (typeof INSTITUTION_STATUSES)[number];
export const CONTACT_ROLES = ["coordinator", "staff"] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];
export const CONTACT_STATUSES = ["pending", "verified", "revoked"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

/** Automated coordination for one request (Phase 6). */
export const AUTOMATION_STATUSES = ["not_started", "running", "paused", "cancelled", "completed"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];
export const DONOR_PHASE_STATUSES = ["pending", "running", "target_reached", "exhausted", "stopped"] as const;
export type DonorPhaseStatus = (typeof DONOR_PHASE_STATUSES)[number];

/** Where an institution record came from. Discovered records are never verified institutions. */
export const INSTITUTION_SOURCES = ["admin", "openstreetmap"] as const;
export type InstitutionSource = (typeof INSTITUTION_SOURCES)[number];
export const INSTITUTION_CAPABILITIES = ["blood_bank", "hospital_with_blood_bank", "hospital"] as const;
export type InstitutionCapability = (typeof INSTITUTION_CAPABILITIES)[number];
export const CAPABILITY_LABELS: Record<InstitutionCapability, string> = {
  blood_bank: "Blood bank",
  hospital_with_blood_bank: "Hospital with blood bank",
  hospital: "Hospital (blood services not confirmed)",
};
/** Admin review of a discovered record: is it relevant, and are its contacts official? */
export const REVIEW_STATUSES = ["unreviewed", "approved", "excluded"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const CHANNEL_TYPES = ["email", "phone", "website"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const CHANNEL_STATUSES = ["unverified", "verified", "invalid", "opted_out"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
export const CHANNEL_SOURCES = ["openstreetmap", "official_website", "admin"] as const;
export type ChannelSource = (typeof CHANNEL_SOURCES)[number];

/**
 * Institutional outreach for one (request, institution). Delivery and the
 * institution's answer are separate: "sent" never means "has blood".
 */
export const OUTREACH_STATUSES = ["awaiting_review", "no_contact", "channel_unavailable", "queued", "sent", "partially_sent", "failed", "excluded", "cancelled"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];
export const OUTREACH_STATUS_LABELS: Record<OutreachStatus, string> = {
  awaiting_review: "Waiting for admin review of contacts",
  no_contact: "No official contact found",
  channel_unavailable: "Email not configured",
  queued: "Queued",
  sent: "Sent",
  partially_sent: "Partly sent",
  failed: "Failed",
  excluded: "Excluded",
  cancelled: "Cancelled",
};
export const INSTITUTION_RESPONSES = ["can_assist", "cannot_assist", "need_info"] as const;
export type InstitutionResponse = (typeof INSTITUTION_RESPONSES)[number];
export const INSTITUTION_RESPONSE_LABELS: Record<InstitutionResponse, string> = {
  can_assist: "Says it may be able to assist (stock not confirmed)",
  cannot_assist: "Cannot assist",
  need_info: "Asked for more information",
};

export const AVAILABILITY_STATUSES = ["available", "unavailable"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

const collapse = (v: string) => v.trim().replace(/\s+/g, " ");
const text = (label: string, min: number, max: number) =>
  z
    .string({ error: `Enter the ${label}.` })
    .transform(collapse)
    .pipe(
      z
        .string()
        .min(min, `Enter the ${label}.`)
        .max(max, `Use at most ${max} characters.`)
        .regex(/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'()/#&:-]*$/u, `The ${label} contains unsupported characters.`),
    );

export const matchingRunSchema = z.strictObject({
  radiusKm: z.union(RADIUS_OPTIONS_KM.map((r) => z.literal(r)) as [z.ZodLiteral<5>, z.ZodLiteral<10>, z.ZodLiteral<25>, z.ZodLiteral<50>]),
});

export const alertBatchSchema = z.strictObject({
  matchingRunId: z.string().regex(/^[a-f0-9]{24}$/, "Run the donor search first."),
});

export const coordinationUpdateSchema = z.strictObject({
  status: z.enum(COORDINATION_STATUSES),
  note: z.string().transform(collapse).pipe(z.string().max(300, "Keep the note under 300 characters.")).optional(),
});

export const linkInstitutionSchema = z.strictObject({
  institutionId: z.string().regex(/^[a-f0-9]{24}$/).nullable(),
});

export const createInstitutionSchema = z.strictObject({
  type: z.enum(INSTITUTION_TYPES),
  legalName: text("legal name", 2, 120),
  displayName: text("display name", 2, 80),
  address: text("address", 5, 200),
  city: citySchema,
  locality: localitySchema,
  publicPhone: z.string().trim().regex(/^\+?[0-9][0-9 -]{5,18}[0-9]$/, "Enter a valid phone number.").nullable().default(null),
  licenceReference: text("licence reference", 3, 80).nullable().default(null),
});

export const institutionStatusSchema = z.strictObject({
  verificationStatus: z.enum(INSTITUTION_STATUSES),
  note: z.string().transform(collapse).pipe(z.string().max(300)).optional(),
});

export const addContactSchema = z.strictObject({
  name: text("contact name", 2, 60),
  phone: indianMobileSchema,
  role: z.enum(CONTACT_ROLES),
});

export const contactStatusSchema = z.strictObject({
  status: z.enum(CONTACT_STATUSES),
});

export const automationActionSchema = z.strictObject({
  action: z.enum(["pause", "resume", "cancel", "run_wave_now", "rediscover", "start"]),
});

export const outreachActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("retry") }),
  z.strictObject({ action: z.literal("send") }),
  z.strictObject({ action: z.literal("cancel") }),
  z.strictObject({
    action: z.literal("record_response"),
    response: z.enum(INSTITUTION_RESPONSES),
    note: z.string().transform(collapse).pipe(z.string().max(300)).optional(),
  }),
]);

export const reviewInstitutionSchema = z.strictObject({
  status: z.enum(["approved", "excluded"]),
  note: z.string().transform(collapse).pipe(z.string().max(300)).optional(),
});

const emailSchema = z.string().trim().toLowerCase().pipe(z.email({ error: "Enter a valid email address." }).max(254));
const phoneTextSchema = z.string().trim().regex(/^\+?[0-9][0-9 -]{5,18}[0-9]$/, "Enter a valid phone number.");
const websiteSchema = z.string().trim().pipe(z.url({ protocol: /^https?$/, error: "Enter a full http(s) address." }).max(300));

/** Admin corrections: add a channel, fix its value, or mark it verified or invalid. */
export const channelUpdateSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("email"), value: emailSchema, status: z.enum(CHANNEL_STATUSES) }),
  z.strictObject({ type: z.literal("phone"), value: phoneTextSchema, status: z.enum(CHANNEL_STATUSES) }),
  z.strictObject({ type: z.literal("website"), value: websiteSchema, status: z.enum(CHANNEL_STATUSES) }),
]);
export const channelStatusSchema = z.strictObject({ status: z.enum(CHANNEL_STATUSES) });

/** An institution's answer from the secure link in an outreach email. */
export const institutionReplySchema = z.strictObject({
  response: z.enum(INSTITUTION_RESPONSES),
  contactName: z.string().transform(collapse).pipe(z.string().max(60).regex(/^[\p{L}\p{M} .'-]*$/u, "Use letters only.")).optional(),
  contactPhone: phoneTextSchema.optional(),
  note: z.string().transform(collapse).pipe(z.string().max(500)).optional(),
});

export const donorContactLinkSchema = z.strictObject({
  hours: z.union([z.literal(6), z.literal(24), z.literal(72)]).default(24),
});

export const messagingSettingsSchema = z
  .strictObject({
    botEnabled: z.boolean(),
    alertsPaused: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");

export { BLOOD_GROUPS, COMPONENTS };
