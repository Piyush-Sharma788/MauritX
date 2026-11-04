import "server-only";
import { BLOOD_GROUP_LABELS, type BloodGroup } from "@/features/donors/schemas";
import { COMPONENT_LABELS, PRIORITY_LABELS, type Component, type Priority } from "@/features/requests/schemas";
import { formatNeededBy } from "@/server/messaging/templates";

/**
 * Institutional outreach text. Institutional facts only: never the patient's
 * name, the requester's number or medical details.
 */

export interface OutreachSummary {
  publicRequestId: string;
  bloodGroup: BloodGroup;
  component: Component;
  unitsRequested: number;
  hospitalName: string;
  locality: string;
  city: string;
  requiredBy: Date;
  priority: Priority;
  verified: boolean;
  respondUrl: string;
  coordinatorPhone: string | null;
  coordinatorEmail: string | null;
}

const group = (g: BloodGroup) => (g === "unknown" ? "To be confirmed by the treating hospital" : BLOOD_GROUP_LABELS[g]);

function lines(s: OutreachSummary): string[] {
  return [
    `Request ID: ${s.publicRequestId}${s.verified ? " (verified by MarutiX with the treating hospital)" : ""}`,
    `Blood group: ${group(s.bloodGroup)}`,
    `Component: ${COMPONENT_LABELS[s.component]}`,
    `Units required: ${s.unitsRequested}`,
    `Patient location: ${s.hospitalName}, ${s.locality}, ${s.city}`,
    `Required by: ${formatNeededBy(s.requiredBy)}`,
    `Priority: ${PRIORITY_LABELS[s.priority].label}`,
  ];
}

const coordinator = (s: OutreachSummary) =>
  s.coordinatorPhone || s.coordinatorEmail
    ? [`MarutiX coordinator: ${[s.coordinatorPhone, s.coordinatorEmail].filter(Boolean).join(" · ")}`]
    : [];

export function outreachEmail(s: OutreachSummary, institutionName: string): { subject: string; text: string } {
  return {
    subject: `MarutiX emergency blood request ${s.publicRequestId}: ${group(s.bloodGroup)} ${COMPONENT_LABELS[s.component]} near ${s.locality}`,
    text: [
      `To: ${institutionName}`,
      "",
      "MarutiX Emergency Blood Request",
      "",
      "An urgent blood requirement has been registered near your institution.",
      "",
      ...lines(s),
      "",
      "Can your institution assist with this request?",
      `Please answer here (no login needed): ${s.respondUrl}`,
      ...coordinator(s),
      "",
      "MarutiX is a voluntary coordination service. It does not hold blood stock, and nothing in this message confirms availability or compatibility.",
      "You received this because your institution's contact is listed publicly as a hospital or blood bank near the patient. To stop MarutiX emails to this address, use the same link.",
      "",
      "MarutiX Emergency Coordination",
    ].join("\n"),
  };
}

export function outreachWhatsApp(s: OutreachSummary): string {
  return [
    "MarutiX Emergency Blood Request",
    "",
    "An urgent blood requirement has been registered near your institution.",
    "",
    ...lines(s),
    "",
    "Can your institution assist?",
    `Reply ASSIST ${s.publicRequestId} or UNABLE ${s.publicRequestId}, or answer here: ${s.respondUrl}`,
    ...coordinator(s),
  ].join("\n");
}
