import { z } from "zod";
import { indianMobileSchema } from "@/features/auth/schemas";

/**
 * WhatsApp Web pilot (whatsapp-web.js) types shared by the admin API, the
 * worker and the admin UI. Browser-safe: no server imports.
 */

export const WHATSAPP_CONNECTION_STATES = ["disconnected", "connecting", "qr_required", "connected", "auth_failed"] as const;
export type WhatsAppConnectionState = (typeof WHATSAPP_CONNECTION_STATES)[number];

export const MESSAGE_KINDS = [
  "admin_test",
  "donor_text",
  "emergency_request",
  "opt_out_confirmation",
  "help_reply",
  "bot_reply",
  "request_confirmation",
  "coordinator_alert",
  "requester_update",
  // A sign-in code the person just asked for (OTP_PROVIDER=whatsapp_web).
  "sign_in_code",
] as const;

/** Replies inside a conversation the person started. Sent first, with their own cap. */
export const CONVERSATIONAL_KINDS: readonly MessageKind[] = ["opt_out_confirmation", "help_reply", "bot_reply", "sign_in_code"];
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * Images the outbox may attach to a message, by configured key (never a path or URL from input).
 * "welcome": the first-contact welcome image (WHATSAPP_WELCOME_IMAGE_*).
 */
export const MEDIA_KEYS = ["welcome"] as const;
export type MediaKey = (typeof MEDIA_KEYS)[number];

export const MESSAGE_STATUSES = ["queued", "sending", "sent", "delivered", "read", "failed", "suppressed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_TEXT_MAX_LENGTH = 1000;

/** Printable text plus newlines and tabs; other control characters are rejected. */
export const messageTextSchema = z
  .string({ error: "Enter a message." })
  .transform((v) => v.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .min(1, "Enter a message.")
      .max(MESSAGE_TEXT_MAX_LENGTH, `Messages can be at most ${MESSAGE_TEXT_MAX_LENGTH} characters.`)
      .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), "The message contains unsupported characters."),
  );

export const sendTestMessageBodySchema = z.strictObject({
  phone: indianMobileSchema,
  text: messageTextSchema,
});

export const connectBodySchema = z.strictObject({
  /** Restart the client even if it is already running (keeps the saved session). */
  restart: z.boolean().default(false),
});

export const idempotencyKeySchema = z
  .string({ error: "An Idempotency-Key header is required." })
  .regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header must be 8–100 letters, digits, dashes or underscores.");

export interface WhatsAppStatusResponse {
  provider: "whatsapp_web";
  state: WhatsAppConnectionState;
  /** False when the worker process hasn't sent a heartbeat recently. */
  workerOnline: boolean;
  busy: boolean;
  account: { maskedNumber: string; pushName: string | null; platform: string | null } | null;
  lastReadyAt: string | null;
  lastDisconnectedAt: string | null;
  lastDisconnectReason: string | null;
  lastError: string | null;
  updatedAt: string | null;
  limits: { maxMessagesPerHour: number; minSendIntervalMs: number };
}

export interface WhatsAppQrResponse {
  /** SVG markup for the current pairing QR. Rotates roughly every 20 seconds. */
  svg: string;
  generatedAt: string;
}

export interface MessageLogEntry {
  id: string;
  kind: MessageKind;
  recipient: string;
  status: MessageStatus;
  failureCode: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
}

export interface MessageLogResponse {
  messages: MessageLogEntry[];
  nextCursor: string | null;
}

export interface QueueMessageResponse {
  messageId: string;
  status: MessageStatus;
  duplicate: boolean;
}
