import "server-only";
import { COMPONENT_LABELS } from "@/features/requests/schemas";
import { emergencyRequestSummarySchema, formatNeededBy, type EmergencyRequestSummary } from "@/server/messaging/templates";

/**
 * Parameters for the approved Cloud API templates (WHATSAPP_BOT.md §12).
 * Meta rejects parameters with newlines, tabs or more than four consecutive
 * spaces, so every value is flattened to one line.
 */

export const templateParam = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 1000);

/** marutix_emergency_alert: {{1}} blood group, {{2}} component, {{3}} units, {{4}} hospital, {{5}} area, {{6}} distance, {{7}} required by, {{8}} request ID. */
export function emergencyAlertParams(input: EmergencyRequestSummary): string[] {
  const s = emergencyRequestSummarySchema.parse(input);
  return [
    s.bloodGroup === "unknown" ? "to be confirmed by the hospital" : s.bloodGroup,
    COMPONENT_LABELS[s.component],
    String(s.unitsRequested),
    s.hospitalName,
    `${s.locality}, ${s.city}`,
    s.distanceKm !== null && s.distanceKm !== undefined ? `about ${s.distanceKm < 1 ? "under 1" : Math.round(s.distanceKm)} km away` : "near you",
    formatNeededBy(s.neededBy),
    s.publicRequestId,
  ].map(templateParam);
}

/** marutix_request_confirmation: {{1}} request ID, {{2}} view-only tracking link. */
export function requestConfirmationParams(publicRequestId: string, trackUrl: string): string[] {
  return [publicRequestId, trackUrl].map(templateParam);
}
