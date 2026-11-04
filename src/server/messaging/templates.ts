import "server-only";
import { z } from "zod";
import { BLOOD_GROUPS } from "@/server/models/donor-profile";

const COMPONENT_LABELS = {
  whole_blood: "Whole blood",
  packed_red_cells: "Packed red cells",
  platelets: "Platelets",
  plasma: "Plasma",
  other: "Other (ask the hospital)",
} as const;

const placeText = (max: number) =>
  z.string().trim().min(2).max(max).regex(/^[\p{L}\p{N} .,'()&/-]+$/u, "Contains unsupported characters");

/**
 * Inputs for the emergency alert (WHATSAPP_BOT.md §4). Every field is
 * constrained so free text (patient names, phone numbers, diagnoses) can't
 * leak into a broadcast. Hospital and locality are institutional, not personal.
 */
export const emergencyRequestSummarySchema = z.strictObject({
  publicRequestId: z.string().regex(/^MX-[0-9A-HJKMNP-TV-Z]{8}$/),
  hospitalName: placeText(120),
  locality: placeText(80),
  city: placeText(60),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(Object.keys(COMPONENT_LABELS) as [keyof typeof COMPONENT_LABELS, ...(keyof typeof COMPONENT_LABELS)[]]),
  unitsRequested: z.number().int().min(1).max(20),
  neededBy: z.date(),
});

export type EmergencyRequestSummary = z.input<typeof emergencyRequestSummarySchema>;

const neededByFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
export const formatNeededBy = (d: Date) => `${neededByFormat.format(d)} IST`;
export const componentLabel = (c: keyof typeof COMPONENT_LABELS) => COMPONENT_LABELS[c];

export function emergencyRequestText(input: EmergencyRequestSummary): string {
  const s = emergencyRequestSummarySchema.parse(input);
  return [
    "MARUTIX — EMERGENCY BLOOD ALERT",
    "",
    `A patient requires ${s.bloodGroup === "unknown" ? "blood (group to be confirmed by the hospital)" : `${s.bloodGroup} blood`}.`,
    "",
    `Hospital: ${s.hospitalName}`,
    `Location: ${s.locality}, ${s.city}`,
    `Component: ${COMPONENT_LABELS[s.component]}`,
    `Units required: ${s.unitsRequested}`,
    `Required by: ${formatNeededBy(s.neededBy)}`,
    `Ref: ${s.publicRequestId}`,
    "",
    "Can you help?",
    "",
    "Reply:",
    "1 — Interested",
    "2 — Unavailable",
    "3 — More information",
    "4 — Stop alerts",
    "",
    "Please coordinate with the hospital. Final donor eligibility and compatibility will be assessed by the blood centre.",
  ].join("\n");
}

export const OPT_OUT_CONFIRMATION_TEXT =
  "You've been unsubscribed from MarutiX. You won't receive any more messages from us, including emergency alerts. To come back later, reply START.";

export const HELP_TEXT = [
  "MarutiX coordinates emergency blood requests and voluntary donors.",
  "",
  "Need blood?",
  "REQUEST: create an emergency blood request",
  "TRACK: see the status of your request",
  "CANCEL: cancel a request you created here",
  "",
  "Donors:",
  "REGISTER: register as a donor",
  "PROFILE: see your donor details",
  "STATUS: see your availability and alerts",
  "UPDATE: change your details",
  "PAUSE / RESUME: pause or resume alerts",
  "STOP: stop all MarutiX messages",
  "",
  "You can also just tell us what you need in your own words. In a medical emergency, call 112.",
].join("\n");

export const INSTITUTION_HELP_TEXT = [
  "MarutiX institutional commands:",
  "REQUESTS: open requests linked to your institution",
  "STATUS: your institution's response status (or STATUS MX-XXXXXXXX)",
  "ACK MX-XXXXXXXX: acknowledge a request",
  "AVAILABLE <group> <component> <units>: report stock, e.g. AVAILABLE O+ PRBC 3 (use 0 if none)",
  "FULFILLED MX-XXXXXXXX or PARTIAL MX-XXXXXXXX: coordinators only",
  "HELP: this list",
].join("\n");
