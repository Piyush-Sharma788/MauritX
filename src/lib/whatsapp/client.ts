import "server-only";

/**
 * Minimal client for the official WhatsApp Business Platform Cloud API.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/
 */

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
}

export class WhatsAppApiError extends Error {
  constructor(
    readonly httpStatus: number | null,
    readonly providerCode: number | null,
    readonly retryable: boolean,
  ) {
    super(`WhatsApp API request failed (http=${httpStatus ?? "network"}, code=${providerCode ?? "n/a"})`);
    this.name = "WhatsAppApiError";
  }
}

/**
 * Graph API error codes that matter for delivery decisions.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export const CLOUD_ERROR = {
  OUTSIDE_SERVICE_WINDOW: 131047, // free-form message more than 24 h after the user's last message
  UNDELIVERABLE: 131026, // not on WhatsApp, old app, or not accepted terms
  RATE_LIMIT: 130429, // throughput limit
  PAIR_RATE_LIMIT: 131056, // too many messages to one number
  SPAM_RATE_LIMIT: 131048,
  TEMPLATE_NOT_FOUND: 132001,
  TEMPLATE_PARAMS: 132000,
  ACCESS_TOKEN: 190,
} as const;

const RETRYABLE_CODES = new Set<number>([CLOUD_ERROR.RATE_LIMIT, CLOUD_ERROR.PAIR_RATE_LIMIT, CLOUD_ERROR.SPAM_RATE_LIMIT, 131000, 131016]);

export type TemplateComponent =
  | { type: "body"; parameters: { type: "text"; text: string }[] }
  | { type: "button"; sub_type: "url"; index: string; parameters: { type: "text"; text: string }[] };

interface SendTemplateInput {
  /** E.164 number, e.g. +919876543210 */
  to: string;
  templateName: string;
  languageCode: string;
  components: TemplateComponent[];
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

async function postMessage(config: WhatsAppConfig, payload: unknown): Promise<{ messageId?: string }> {
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    // A timeout may still have reached Meta, so it is never retried (no duplicate messages or codes).
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new WhatsAppApiError(null, null, !timedOut);
  }

  const body = (await response.json().catch(() => null)) as
    | { messages?: { id?: string }[]; error?: { code?: number } }
    | null;

  if (!response.ok) {
    const code = body?.error?.code ?? null;
    const retryable = response.status >= 500 || response.status === 429 || (code !== null && RETRYABLE_CODES.has(code));
    throw new WhatsAppApiError(response.status, code, retryable);
  }
  return { messageId: body?.messages?.[0]?.id };
}

/** A free-form text message. Allowed only within 24 hours of the person's last message to us. */
export async function sendTextMessage(config: WhatsAppConfig, input: { to: string; body: string }) {
  // Single attempt: the outbox dispatcher owns retries, so a timeout never becomes a duplicate.
  return postMessage(config, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to.replace(/^\+/, ""),
    type: "text",
    text: { preview_url: false, body: input.body },
  });
}

/** One template send without the built-in retry (the outbox dispatcher retries). */
export async function sendTemplateOnce(config: WhatsAppConfig, input: SendTemplateInput) {
  return postMessage(config, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to.replace(/^\+/, ""),
    type: "template",
    template: { name: input.templateName, language: { code: input.languageCode }, components: input.components },
  });
}

export async function sendTemplateMessage(config: WhatsAppConfig, input: SendTemplateInput) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to.replace(/^\+/, ""),
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      components: input.components,
    },
  };

  for (let attempt = 1; ; attempt++) {
    try {
      return await postMessage(config, payload);
    } catch (error) {
      if (!(error instanceof WhatsAppApiError) || !error.retryable || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}
