import "server-only";
import type { Types } from "mongoose";
import { logger } from "@/lib/logger";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { getMessagingProviderName, getWhatsAppCloudConfig } from "@/lib/whatsapp/cloud-config";
import { requestConfirmationParams } from "@/server/messaging/cloud-templates";
import { enqueueMessage } from "@/server/messaging/queue";
import { readConnectionStatus } from "@/server/whatsapp/connection-store";

/**
 * Request notifications through the provider-neutral outbox. Phase 4 sends
 * only the requester's own confirmation, and only when they ask for it.
 * There are no donor alerts or broadcasts here.
 */

export function requestConfirmationText(publicRequestId: string, trackUrl: string): string {
  return [
    `MarutiX: your blood request ${publicRequestId} has been received.`,
    "Status: Pending verification. Our team will verify it with the hospital.",
    `Track it here: ${trackUrl}`,
    "MarutiX doesn't guarantee blood availability. Stay in touch with the hospital's blood centre, and call 112 in a life-threatening emergency.",
    "Reply STOP to stop messages from MarutiX.",
  ].join("\n");
}

/**
 * Queues the confirmation if WhatsApp is connected right now. Otherwise it
 * says "unavailable" rather than promising a message that may expire unsent.
 */
export async function queueRequestConfirmation(input: {
  requestId: Types.ObjectId;
  publicRequestId: string;
  phoneE164: string;
  trackUrl: string;
}): Promise<"queued" | "unavailable" | "suppressed"> {
  try {
    if (getMessagingProviderName() === "whatsapp_cloud") {
      // The official API has no session to be offline; it only needs its configuration.
      if (!getWhatsAppCloudConfig()) return "unavailable";
    } else {
      const status = await readConnectionStatus(getWhatsAppWebConfig());
      if (!status.workerOnline || status.state !== "connected") return "unavailable";
    }
    const result = await enqueueMessage({
      kind: "request_confirmation",
      templateName: "request_confirmation_v1",
      phoneE164: input.phoneE164,
      body: requestConfirmationText(input.publicRequestId, input.trackUrl),
      idempotencyKey: `request_confirmation:${input.requestId.toString()}`,
      requestId: input.requestId.toString(),
      templateParams: requestConfirmationParams(input.publicRequestId, input.trackUrl),
      recordSuppressed: true,
    });
    return result.outcome === "suppressed" ? "suppressed" : "queued";
  } catch (error) {
    // The pilot may not be configured; the request itself still succeeds.
    logger.warn("request.confirmation_not_queued", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return "unavailable";
  }
}
