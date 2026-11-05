import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { logger } from "@/lib/logger";
import type { WhatsAppCloudConfig } from "@/lib/whatsapp/cloud-config";
import { recordDeliveryAck } from "@/server/messaging/dispatcher";
import { handleInboundMessage, MAX_INBOUND_TEXT, type InboundEvent, type InboundMessage } from "@/server/messaging/inbound";
import { OtpChallenge } from "@/server/models/otp-challenge";

/**
 * WhatsApp Cloud API webhooks: inbound messages and delivery statuses.
 * Untrusted until the signature checks out: Meta signs each POST with
 * HMAC-SHA256 of the raw body using the App Secret (X-Hub-Signature-256).
 * Inbound messages enter the same pipeline as the pilot (dedupe by message
 * ID, rate limit, STOP, conversation engine), so redeliveries are harmless.
 */

export function signatureFor(rawBody: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** Constant-time check of X-Hub-Signature-256 against the raw request body. */
export function verifySignature(rawBody: string | Buffer, header: string | null, appSecret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = Buffer.from(signatureFor(rawBody, appSecret));
  const given = Buffer.from(header.toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Reads a request body as its exact raw bytes (the signature covers them), stopping as
 * soon as it passes `maxBytes`, so an oversized or chunked body without Content-Length
 * is never held in memory in full. Returns null when the body is too large.
 */
export async function readRawBodyLimited(request: Request, maxBytes: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** GET handshake: echo hub.challenge only for our verify token. */
export function verifySubscription(params: URLSearchParams, verifyToken: string): string | null {
  const mode = params.get("hub.mode") ?? params.get("hub_mode");
  const token = params.get("hub.verify_token") ?? params.get("hub_verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? params.get("hub_challenge");
  if (mode !== "subscribe" || !challenge || !/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

const messageSchema = z.object({
  from: z.string().regex(/^\d{6,20}$/),
  id: z.string().min(1).max(200),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  location: z.object({ latitude: z.coerce.number(), longitude: z.coerce.number() }).optional(),
  button: z.object({ text: z.string() }).optional(),
  image: z.object({ caption: z.string().optional() }).loose().optional(),
  video: z.object({ caption: z.string().optional() }).loose().optional(),
  document: z.object({ caption: z.string().optional() }).loose().optional(),
  interactive: z
    .object({ button_reply: z.object({ title: z.string() }).optional(), list_reply: z.object({ title: z.string() }).optional() })
    .optional(),
});

const statusSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(["sent", "delivered", "read", "failed", "deleted", "warning"]),
  errors: z.array(z.object({ code: z.number() })).optional(),
});

export const webhookPayloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            messaging_product: z.literal("whatsapp").optional(),
            metadata: z.object({ phone_number_id: z.string() }),
            messages: z.array(z.unknown()).optional(),
            statuses: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});

/** "919876543210" → "+919876543210" for Indian mobiles only (MarutiX serves India). */
const indianE164 = (digits: string) => (/^91[6-9]\d{9}$/.test(digits) ? `+${digits}` : null);

/** Message types people send that the bot can't read: they get a one-line explanation. */
const UNSUPPORTED_TYPES = new Set(["image", "video", "audio", "voice", "document", "sticker", "contacts"]);

/**
 * One webhook message → the pipeline's input, or the reason it's dropped.
 * Text, buttons, list replies and locations are read; a photo, video or file
 * with a caption is read as its caption; other media becomes an "unsupported"
 * event (polite reply); reactions and system messages are dropped.
 */
export function toInboundEvent(raw: unknown): { event: InboundEvent } | { dropped: string } {
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) return { dropped: "unparseable_message" };
  const m = parsed.data;
  const fromE164 = indianE164(m.from);
  if (!fromE164) return { dropped: "not_an_indian_mobile" };
  const caption = m.type === "image" ? m.image?.caption : m.type === "video" ? m.video?.caption : m.type === "document" ? m.document?.caption : undefined;
  const text =
    m.type === "text" ? m.text?.body
    : m.type === "button" ? m.button?.text
    : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
    : caption?.trim() ? caption
    : undefined;
  if (text !== undefined) {
    if (text.length > MAX_INBOUND_TEXT) logger.info("whatsapp_cloud.inbound_truncated", { length: text.length });
    return { event: { providerMessageId: m.id, fromE164, input: { type: "text", text: text.slice(0, MAX_INBOUND_TEXT) } } };
  }
  if (m.type === "location") {
    if (m.location && Number.isFinite(m.location.latitude) && Number.isFinite(m.location.longitude)) {
      return { event: { providerMessageId: m.id, fromE164, input: { type: "location", latitude: m.location.latitude, longitude: m.location.longitude } } };
    }
    return { dropped: "invalid_location" };
  }
  if (UNSUPPORTED_TYPES.has(m.type)) return { event: { providerMessageId: m.id, fromE164, input: { type: "unsupported", mediaType: m.type } } };
  return { dropped: m.type === "reaction" ? "reaction" : "unsupported_system_type" };
}

/** Text, buttons and locations only (null for anything else). */
export function toInboundMessage(raw: unknown): InboundMessage | null {
  const result = toInboundEvent(raw);
  return "event" in result && result.event.input.type !== "unsupported" ? (result.event as InboundMessage) : null;
}

const ACK = { sent: "server", delivered: "device", read: "read", failed: "error" } as const;

export interface WebhookResult {
  inbound: number;
  duplicates: number;
  statuses: number;
  ignored: number;
}

/** Applies a verified payload. Throws on infrastructure errors so Meta redelivers (idempotent). */
export async function processCloudWebhook(payload: z.output<typeof webhookPayloadSchema>, config: WhatsAppCloudConfig, now = new Date()): Promise<WebhookResult> {
  const result: WebhookResult = { inbound: 0, duplicates: 0, statuses: 0, ignored: 0 };
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      // Events for another number on the same business account aren't ours.
      if (change.field !== "messages" || change.value.metadata.phone_number_id !== config.phoneNumberId) {
        result.ignored += 1;
        continue;
      }
      for (const raw of change.value.messages ?? []) {
        const converted = toInboundEvent(raw);
        if ("dropped" in converted) {
          // Logged without the sender, so a message never disappears silently.
          logger.info("whatsapp_cloud.inbound_dropped", { reason: converted.dropped, type: typeof (raw as { type?: unknown })?.type === "string" ? String((raw as { type: string }).type).slice(0, 30) : "unknown" });
          result.ignored += 1;
          continue;
        }
        const outcome = await handleInboundMessage(converted.event, now);
        if (outcome === "duplicate") result.duplicates += 1;
        else result.inbound += 1;
      }
      for (const raw of change.value.statuses ?? []) {
        const parsed = statusSchema.safeParse(raw);
        if (!parsed.success || !(parsed.data.status in ACK)) {
          result.ignored += 1;
          continue;
        }
        const s = parsed.data;
        const ack = ACK[s.status as keyof typeof ACK];
        const failureCode = s.errors?.[0]?.code ? `CLOUD_${s.errors[0].code}` : undefined;
        await recordDeliveryAck(s.id, ack, now, failureCode);
        // Sign-in codes are sent outside the outbox; track their delivery too.
        await OtpChallenge.updateOne({ providerMessageId: s.id }, { $set: { deliveryStatus: s.status, deliveryUpdatedAt: now, ...(failureCode ? { deliveryFailureCode: failureCode } : {}) } });
        result.statuses += 1;
      }
    }
  }
  logger.info("whatsapp_cloud.webhook", { ...result });
  return result;
}
