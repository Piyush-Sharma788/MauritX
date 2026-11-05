/**
 * Provider abstraction for outbound messaging. The WhatsApp Web pilot
 * (whatsapp-web.js) implements it today; the official WhatsApp Business
 * Platform can implement the same interface later without touching the
 * queue, consent or dispatch logic.
 */

export type ProviderName = "whatsapp_web" | "whatsapp_cloud";

export type MessagingErrorCode =
  | "NOT_CONNECTED"
  | "NOT_ON_WHATSAPP"
  | "SEND_TIMEOUT"
  | "SEND_FAILED"
  // Cloud API: free-form text more than 24 h after the person's last message, and no approved template for this kind.
  | "OUTSIDE_SERVICE_WINDOW"
  // Cloud API: the platform refused the request (bad token, template or parameters).
  | "REJECTED";

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    readonly retryable: boolean,
  ) {
    super(`Messaging provider error: ${code}`);
    this.name = "MessagingError";
  }
}

/** What a provider may need beyond the text: the official API must use templates outside the 24-hour window. */
export interface SendContext {
  kind: import("@/features/whatsapp/types").MessageKind;
  /** Values for the approved template of this kind, if it has one. */
  templateParams: string[] | null;
  /** The recipient's most recent message to us, which opens a 24-hour window for free-form replies. */
  lastInboundAt: Date | null;
  now: Date;
}

export interface MessagingProvider {
  readonly name: ProviderName;
  /** True when the provider can accept a send right now. */
  isReady(): boolean;
  /** Sends one message. Throws MessagingError on failure. */
  sendText(phoneE164: string, body: string, context?: SendContext): Promise<{ providerMessageId: string }>;
}

/** Delivery acknowledgements normalised across providers. */
export type DeliveryAck = "server" | "device" | "read" | "error";
