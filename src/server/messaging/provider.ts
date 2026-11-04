/**
 * Provider abstraction for outbound messaging. The WhatsApp Web pilot
 * (whatsapp-web.js) implements it today; the official WhatsApp Business
 * Platform can implement the same interface later without touching the
 * queue, consent or dispatch logic.
 */

export type ProviderName = "whatsapp_web" | "whatsapp_cloud";

export type MessagingErrorCode = "NOT_CONNECTED" | "NOT_ON_WHATSAPP" | "SEND_TIMEOUT" | "SEND_FAILED";

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    readonly retryable: boolean,
  ) {
    super(`Messaging provider error: ${code}`);
    this.name = "MessagingError";
  }
}

export interface MessagingProvider {
  readonly name: ProviderName;
  /** True when the provider can accept a send right now. */
  isReady(): boolean;
  /** Sends a plain-text message. Throws MessagingError on failure. */
  sendText(phoneE164: string, body: string): Promise<{ providerMessageId: string }>;
}

/** Delivery acknowledgements normalised across providers. */
export type DeliveryAck = "server" | "device" | "read" | "error";
