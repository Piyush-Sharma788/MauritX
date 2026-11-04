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
export const DONOR_RESPONSES = ["interested", "unavailable"] as const;
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
  "donation_confirmed",
  "not_proceeding",
] as const;
export type CoordinationStatus = (typeof COORDINATION_STATUSES)[number];

export const COORDINATION_LABELS: Record<CoordinationStatus, string> = {
  interested: "Donor interested",
  coordinator_contacted: "Coordinator contacted donor",
  hospital_coordination: "Hospital coordination initiated",
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

export const messagingSettingsSchema = z
  .strictObject({
    botEnabled: z.boolean(),
    alertsPaused: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");

export { BLOOD_GROUPS, COMPONENTS };
