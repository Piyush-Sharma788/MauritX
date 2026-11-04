import "server-only";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { BLOOD_GROUPS } from "@/server/models/donor-profile";

const COMPONENT_LABELS = {
  whole_blood: "Whole blood",
  packed_red_cells: "Packed red cells",
  platelets: "Platelets",
  plasma: "Plasma",
  other: "Other (see link)",
} as const;

/**
 * Inputs for the donor alert from WHATSAPP_BOT.md §4. Every field is
 * constrained so free text (patient names, diagnoses) cannot leak into a
 * message preview.
 */
export const emergencyRequestSummarySchema = z.strictObject({
  area: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N} .,'()-]+$/u, "Area contains unsupported characters"),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(Object.keys(COMPONENT_LABELS) as [keyof typeof COMPONENT_LABELS, ...(keyof typeof COMPONENT_LABELS)[]]),
  neededBy: z.date(),
  secureLink: z.url(),
});

export type EmergencyRequestSummary = z.input<typeof emergencyRequestSummarySchema>;

const neededByFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export function emergencyRequestText(input: EmergencyRequestSummary): string {
  const summary = emergencyRequestSummarySchema.parse(input);
  if (new URL(summary.secureLink).origin !== new URL(getEnv().APP_BASE_URL).origin) {
    throw new Error("Emergency request links must point to the MarutiX app");
  }
  return [
    `MarutiX blood request near ${summary.area}.`,
    `Blood group: ${summary.bloodGroup === "unknown" ? "Not known yet" : summary.bloodGroup}`,
    `Component: ${COMPONENT_LABELS[summary.component]}`,
    `Needed by: ${neededByFormat.format(summary.neededBy)} IST`,
    `Can you consider helping? Open the secure link: ${summary.secureLink}`,
    "The blood centre makes the final eligibility decision.",
    "Reply STOP to stop alerts.",
  ].join("\n");
}

export const OPT_OUT_CONFIRMATION_TEXT =
  "You've been unsubscribed from MarutiX. You won't receive any more messages from us, including emergency alerts. To come back later, reply START.";

export const HELP_TEXT = [
  "MarutiX coordinates voluntary blood donor alerts.",
  "REGISTER: register as a donor",
  "STATUS: see your donor details",
  "UPDATE: change your details",
  "PAUSE / RESUME: pause or resume alerts",
  "STOP: stop all MarutiX messages",
  "To manage your profile on the website, sign in at MarutiX with this number. In a medical emergency, call 112.",
].join("\n");
