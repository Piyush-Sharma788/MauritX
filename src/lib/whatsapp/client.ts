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

type TemplateComponent =
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
  } catch {
    throw new WhatsAppApiError(null, null, true);
  }

  const body = (await response.json().catch(() => null)) as
    | { messages?: { id?: string }[]; error?: { code?: number } }
    | null;

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw new WhatsAppApiError(response.status, body?.error?.code ?? null, retryable);
  }
  return { messageId: body?.messages?.[0]?.id };
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
