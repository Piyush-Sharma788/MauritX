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
  | "REJECTED"
  // The image couldn't be prepared (file unreadable, upload refused) before anything was sent.
  | "MEDIA_UNAVAILABLE";

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    readonly retryable: boolean,
    /**
     * True when the provider knows nothing reached WhatsApp (refused before or by the
     * platform), so a different message may safely be sent instead. False when the send
     * may have gone through (timeouts, errors after the send started).
     */
    readonly notSent: boolean = retryable,
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

/** A configured image (see lib/whatsapp/media-config.ts). */
export type OutboundImage = import("@/lib/whatsapp/media-config").MediaAsset;

export interface MessagingProvider {
  readonly name: ProviderName;
  /** True when the provider can accept a send right now. */
  isReady(): boolean;
  /** Sends one message. Throws MessagingError on failure. */
  sendText(phoneE164: string, body: string, context?: SendContext): Promise<{ providerMessageId: string }>;
  /**
   * Optional: one image with a caption. Throws MessagingError; `notSent` tells the
   * dispatcher whether it may fall back to sending the caption as text.
   */
  sendImage?(phoneE164: string, image: OutboundImage, caption: string, context?: SendContext): Promise<{ providerMessageId: string }>;
}

/** Delivery acknowledgements normalised across providers. */
export type DeliveryAck = "server" | "device" | "read" | "error";
