import { z } from "zod";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";

/**
 * Donor validation shared by the web form, the API and the WhatsApp bot.
 * Browser-safe: no server imports.
 */

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export const BLOOD_GROUP_LABELS: Record<BloodGroup, string> = {
  "A+": "A+", "A-": "A−", "B+": "B+", "B-": "B−", "AB+": "AB+", "AB-": "AB−", "O+": "O+", "O-": "O−", unknown: "Not sure",
};

const collapse = (v: string) => v.trim().replace(/\s+/g, " ");

export const donorNameSchema = z
  .string({ error: "Enter your name." })
  .transform(collapse)
  .pipe(
    z
      .string()
      .min(2, "Enter at least 2 characters.")
      .max(60, "Use at most 60 characters.")
      .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, "Use letters, spaces, dots, apostrophes or hyphens only."),
  );

const placeSchema = (label: string, max: number) =>
  z
    .string({ error: `Enter your ${label}.` })
    .transform(collapse)
    .pipe(
      z
        .string()
        .min(2, `Enter your ${label}.`)
        .max(max, `Use at most ${max} characters.`)
        .regex(/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'()/-]*$/u, `The ${label} contains unsupported characters.`),
    );

export const citySchema = placeSchema("city", 60);
export const localitySchema = placeSchema("locality or area", 80);
export const bloodGroupSchema = z.enum(BLOOD_GROUPS, { error: "Choose a blood group, or “Not sure”." });

/** Rough bounding box for India. Locations outside it are rejected. */
export const INDIA_BOUNDS = { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5 } as const;

export const locationSchema = z
  .strictObject({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .refine(
    (l) => l.latitude >= INDIA_BOUNDS.minLat && l.latitude <= INDIA_BOUNDS.maxLat && l.longitude >= INDIA_BOUNDS.minLng && l.longitude <= INDIA_BOUNDS.maxLng,
    "Location must be in India.",
  );

/** Keeps roughly 1 km of precision. Donor locations are never stored exactly. */
export function coarsenLocation(l: { latitude: number; longitude: number }) {
  return { latitude: Math.round(l.latitude * 100) / 100, longitude: Math.round(l.longitude * 100) / 100 };
}

/** "YYYY-MM-DD" in IST. */
export function todayInIndia(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export const lastDonationDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Enter a real date.")
  .refine((v) => v >= "1950-01-01", "Enter a date after 1950.")
  .refine((v) => v <= todayInIndia(), "The date can't be in the future.");

export const donorRegistrationSchema = z.strictObject({
  name: donorNameSchema,
  bloodGroup: bloodGroupSchema,
  city: citySchema,
  locality: localitySchema,
  location: locationSchema.nullable().default(null),
  lastDonationDate: lastDonationDateSchema.nullable().default(null),
  availableForRequests: z.boolean({ error: "Choose your availability." }),
  notificationConsent: z.boolean().default(false),
  privacyNoticeVersion: z.literal(PRIVACY_NOTICE_VERSION, { error: "Please review the latest privacy notice and try again." }),
});

export const donorProfileUpdateSchema = z
  .strictObject({
    name: donorNameSchema,
    bloodGroup: bloodGroupSchema,
    city: citySchema,
    locality: localitySchema,
    location: locationSchema.nullable(),
    lastDonationDate: lastDonationDateSchema.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const availabilitySchema = z.strictObject({ availableForRequests: z.boolean() });

export const notificationActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("enable"),
    consent: z.literal(true, { error: "Please confirm that you agree to receive alerts." }),
    privacyNoticeVersion: z.literal(PRIVACY_NOTICE_VERSION, { error: "Please review the latest privacy notice and try again." }),
  }),
  z.strictObject({ action: z.literal("pause") }),
  z.strictObject({ action: z.literal("resume") }),
  z.strictObject({ action: z.literal("opt_out") }),
]);

export type DonorRegistrationInput = z.output<typeof donorRegistrationSchema>;
export type DonorProfileUpdate = z.output<typeof donorProfileUpdateSchema>;
export type NotificationAction = z.output<typeof notificationActionSchema>["action"];
