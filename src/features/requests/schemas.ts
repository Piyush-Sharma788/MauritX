import { z } from "zod";
import { indianMobileSchema } from "@/features/auth/schemas";
import { BLOOD_GROUPS, citySchema, localitySchema, locationSchema } from "@/features/donors/schemas";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";

/**
 * Emergency blood request validation, shared by the request form and the API.
 * Browser-safe: no server imports.
 */

export const REQUEST_STATUSES = [
  "pending_verification",
  "verified",
  "active",
  "partially_fulfilled",
  "fulfilled",
  "cancelled",
  "expired",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const OPEN_STATUSES: readonly RequestStatus[] = ["pending_verification", "verified", "active", "partially_fulfilled"];
export const isOpenStatus = (s: RequestStatus) => OPEN_STATUSES.includes(s);

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending_verification: "Pending verification",
  verified: "Verified",
  active: "Active",
  partially_fulfilled: "Partially fulfilled",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const COMPONENTS = ["whole_blood", "packed_red_cells", "platelets", "plasma", "other"] as const;
export type Component = (typeof COMPONENTS)[number];
export const COMPONENT_LABELS: Record<Component, string> = {
  whole_blood: "Whole blood",
  packed_red_cells: "Packed red cells (PRBC)",
  platelets: "Platelets",
  plasma: "Plasma (FFP)",
  other: "Other (e.g. cryoprecipitate)",
};

export const PRIORITIES = ["critical", "urgent", "scheduled"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, { label: string; description: string }> = {
  critical: { label: "Critical", description: "Needed within a few hours" },
  urgent: { label: "Urgent", description: "Needed within 24 hours" },
  scheduled: { label: "Scheduled", description: "Planned procedure or later date" },
};

const collapse = (v: string) => v.trim().replace(/\s+/g, " ");
const personName = (label: string, min: number) =>
  z
    .string({ error: `Enter the ${label}.` })
    .transform(collapse)
    .pipe(
      z
        .string()
        .min(min, `Enter the ${label}.`)
        .max(60, "Use at most 60 characters.")
        .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, "Use letters, spaces, dots, apostrophes or hyphens only."),
    );

const freeText = (label: string, min: number, max: number) =>
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

/** Hospital landline or mobile: digits with optional +, spaces or dashes. */
const hospitalPhoneSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().regex(/^\+?[0-9][0-9 -]{5,18}[0-9]$/, "Enter a valid phone number, or leave it empty."));

/** Required-by must be between 1 hour ago and 30 days ahead. */
export const requiredBySchema = z.iso
  .datetime({ offset: true, error: "Choose the date and time blood is needed by." })
  .transform((v) => new Date(v))
  .refine((d) => d.getTime() >= Date.now() - 60 * 60 * 1000, "The required-by time can't be in the past.")
  .refine((d) => d.getTime() <= Date.now() + 30 * 24 * 60 * 60 * 1000, "Choose a time within the next 30 days.");

export const patientStepSchema = z.strictObject({
  patientName: personName("patient's name or initials", 1),
  patientAge: z.number().int().min(0, "Enter an age from 0 to 120.").max(120, "Enter an age from 0 to 120.").nullable(),
  contactName: personName("contact person's name", 2),
  contactPhone: indianMobileSchema,
});

export const bloodStepSchema = z.strictObject({
  bloodGroup: z.enum(BLOOD_GROUPS, { error: "Choose a blood group, or “Not sure”." }),
  component: z.enum(COMPONENTS, { error: "Choose the blood component the hospital asked for." }),
  unitsRequested: z.number({ error: "Enter the number of units." }).int().min(1, "Enter at least 1 unit.").max(20, "Enter at most 20 units."),
  requiredBy: requiredBySchema,
  priority: z.enum(PRIORITIES, { error: "Choose how urgent this is." }),
});

export const hospitalStepSchema = z.strictObject({
  hospitalName: freeText("hospital name", 2, 120),
  hospitalAddress: freeText("hospital address", 5, 200),
  city: citySchema,
  locality: localitySchema,
  hospitalPhone: hospitalPhoneSchema.nullable(),
  location: locationSchema.nullable(),
});

export const createRequestSchema = z.strictObject({
  ...patientStepSchema.shape,
  ...bloodStepSchema.shape,
  ...hospitalStepSchema.shape,
  whatsappUpdates: z.boolean().default(false),
  consent: z.literal(true, { error: "Please confirm the details and agree to how they'll be used." }),
  privacyNoticeVersion: z.literal(PRIVACY_NOTICE_VERSION, { error: "Please review the latest privacy notice and try again." }),
});
export type CreateRequestInput = z.output<typeof createRequestSchema>;

export const PUBLIC_REQUEST_ID = /^MX-[0-9A-HJKMNP-TV-Z]{8}$/;
export const publicRequestIdSchema = z
  .string()
  .transform((v) => {
    const t = v.trim().toUpperCase();
    return t.startsWith("MX-") ? t : `MX-${t}`;
  })
  .pipe(z.string().regex(PUBLIC_REQUEST_ID, "Enter a request ID like MX-7K3Q9P2A."));

export const requesterStatusSchema = z.strictObject({
  status: z.enum(["partially_fulfilled", "fulfilled", "cancelled"]),
});

export const adminStatusSchema = z.strictObject({
  status: z.enum(REQUEST_STATUSES),
  note: z
    .string()
    .transform(collapse)
    .pipe(z.string().max(300, "Keep the note under 300 characters."))
    .optional(),
});

export const shareLinkSchema = z.strictObject({
  hours: z.union([z.literal(24), z.literal(72), z.literal(168)]).default(72),
});

export const TRACKING_TOKEN = /^[A-Za-z0-9_-]{43}$/;
