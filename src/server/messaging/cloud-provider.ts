import "server-only";
import type { MessageKind } from "@/features/whatsapp/types";
import { logger } from "@/lib/logger";
import type { WhatsAppCloudConfig } from "@/lib/whatsapp/cloud-config";
import { CLOUD_ERROR, sendTemplateOnce, sendTextMessage, WhatsAppApiError } from "@/lib/whatsapp/client";
import { MessagingError, type MessagingProvider, type SendContext } from "@/server/messaging/provider";

/**
 * The official WhatsApp Business Platform (Cloud API) behind the same
 * MessagingProvider interface as the whatsapp-web.js pilot, so the queue,
 * consent checks and dispatcher don't change.
 *
 * Platform rule: free-form text is allowed only within 24 hours of the
 * person's last message. Outside that window a business-initiated message
 * must be an approved template. Kinds without a template can't be sent then.
 */

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Stay clear of the boundary: our clock and Meta's may differ slightly.
const WINDOW_SAFETY_MS = 10 * 60 * 1000;

export type CloudChoice =
  | { type: "text" }
  | { type: "template"; name: string; params: string[] }
  | { type: "blocked" };

export function templateFor(kind: MessageKind, templates: WhatsAppCloudConfig["templates"]): string | null {
  if (kind === "emergency_request") return templates.emergencyAlert;
  if (kind === "request_confirmation") return templates.requestConfirmation;
  return null;
}

/** Text inside the 24-hour window; otherwise this kind's approved template, if it has one. */
export function chooseCloudMessage(context: SendContext, templates: WhatsAppCloudConfig["templates"]): CloudChoice {
  const inWindow = context.lastInboundAt !== null && context.now.getTime() - context.lastInboundAt.getTime() < SERVICE_WINDOW_MS - WINDOW_SAFETY_MS;
  if (inWindow) return { type: "text" };
  const name = templateFor(context.kind, templates);
  if (name && context.templateParams?.length) return { type: "template", name, params: context.templateParams };
  return { type: "blocked" };
}

/** Graph API failure → the dispatcher's retry vocabulary. */
export function toMessagingError(error: unknown): MessagingError {
  if (!(error instanceof WhatsAppApiError)) return new MessagingError("SEND_FAILED", true);
  if (error.providerCode === CLOUD_ERROR.OUTSIDE_SERVICE_WINDOW) return new MessagingError("OUTSIDE_SERVICE_WINDOW", false);
  if (error.providerCode === CLOUD_ERROR.UNDELIVERABLE) return new MessagingError("NOT_ON_WHATSAPP", false);
  if (error.httpStatus === null) return error.retryable ? new MessagingError("SEND_FAILED", true) : new MessagingError("SEND_TIMEOUT", false);
  if (error.retryable) return new MessagingError("SEND_FAILED", true);
  return new MessagingError("REJECTED", false);
}

export class CloudApiMessagingProvider implements MessagingProvider {
  readonly name = "whatsapp_cloud" as const;

  constructor(private readonly config: WhatsAppCloudConfig) {}

  isReady(): boolean {
    return Boolean(this.config.accessToken && this.config.phoneNumberId);
  }

  async sendText(phoneE164: string, body: string, context?: SendContext): Promise<{ providerMessageId: string }> {
    const choice = context ? chooseCloudMessage(context, this.config.templates) : ({ type: "text" } as const);
    if (choice.type === "blocked") throw new MessagingError("OUTSIDE_SERVICE_WINDOW", false);
    const api = { accessToken: this.config.accessToken, phoneNumberId: this.config.phoneNumberId, graphApiVersion: this.config.graphApiVersion };
    try {
      const result =
        choice.type === "text"
          ? await sendTextMessage(api, { to: phoneE164, body })
          : await sendTemplateOnce(api, {
              to: phoneE164,
              templateName: choice.name,
              languageCode: this.config.templates.language,
              components: [{ type: "body", parameters: choice.params.map((text) => ({ type: "text" as const, text })) }],
            });
      if (!result.messageId) throw new MessagingError("SEND_FAILED", false);
      return { providerMessageId: result.messageId };
    } catch (error) {
      if (error instanceof MessagingError) throw error;
      const mapped = toMessagingError(error);
      logger.warn("whatsapp_cloud.send_failed", {
        code: mapped.code,
        httpStatus: error instanceof WhatsAppApiError ? error.httpStatus : null,
        providerCode: error instanceof WhatsAppApiError ? error.providerCode : null,
        type: choice.type,
      });
      throw mapped;
    }
  }
}
