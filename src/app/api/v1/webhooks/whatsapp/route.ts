import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { getWhatsAppCloudConfig } from "@/lib/whatsapp/cloud-config";
import { processCloudWebhook, readRawBodyLimited, verifySignature, verifySubscription, webhookPayloadSchema } from "@/server/messaging/cloud-webhook";
import { reportError } from "@/server/monitoring/report";

const MAX_BODY_BYTES = 1024 * 1024;
const plain = (body: string, status: number) => new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * GET /api/v1/webhooks/whatsapp: Meta's subscription handshake.
 * Echoes hub.challenge only when hub.verify_token matches WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 */
export async function GET(request: NextRequest) {
  const config = getWhatsAppCloudConfig();
  if (!config?.verifyToken) return plain("Not configured", 404);
  const challenge = verifySubscription(request.nextUrl.searchParams, config.verifyToken);
  return challenge ? plain(challenge, 200) : plain("Forbidden", 403);
}

/**
 * POST /api/v1/webhooks/whatsapp: inbound messages and delivery statuses.
 * Rejected unless X-Hub-Signature-256 matches the raw body (App Secret).
 * Answers 200 once handled; 500 on infrastructure errors so Meta redelivers
 * (processing is idempotent by message ID).
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const config = getWhatsAppCloudConfig();
  if (!config?.appSecret) return plain("Not configured", 404);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return plain("Too large", 413);
  // Streamed with a hard cap: a chunked body without Content-Length is never buffered past the limit.
  const raw = await readRawBodyLimited(request, MAX_BODY_BYTES);
  if (!raw) {
    logger.warn("whatsapp_cloud.webhook_too_large", { requestId });
    return plain("Too large", 413);
  }

  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), config.appSecret)) {
    logger.warn("whatsapp_cloud.webhook_bad_signature", { requestId });
    return plain("Invalid signature", 401);
  }

  let payload;
  try {
    payload = webhookPayloadSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    // Signed but not a shape we handle: acknowledge so Meta doesn't retry forever.
    logger.warn("whatsapp_cloud.webhook_unrecognised", { requestId });
    return plain("Ignored", 200);
  }

  try {
    await processCloudWebhook(payload, config);
    return plain("OK", 200);
  } catch (error) {
    await reportError(error, { source: "whatsapp_webhook", event: "whatsapp_cloud.webhook_failed", requestId });
    return plain("Retry", 500);
  }
}
