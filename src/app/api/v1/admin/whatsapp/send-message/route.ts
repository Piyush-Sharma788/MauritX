import { Types } from "mongoose";
import { idempotencyKeySchema, sendTestMessageBodySchema, type QueueMessageResponse } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { queueAdminTestMessage } from "@/server/messaging/queue";

/**
 * POST /api/v1/admin/whatsapp/send-message: queue a single test message.
 * Recipients are limited to WHATSAPP_WEB_TEST_RECIPIENTS or consented donors.
 * Requires an Idempotency-Key header. Returns 202; delivery happens in the worker.
 */
export const POST = apiRoute(async (request, ctx) => {
  const admin = await requireAdmin();
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key") ?? undefined);
  if (!key.success) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", key.error.issues[0].message);
  const body = await parseJsonBody(request, sendTestMessageBodySchema);

  const result = await queueAdminTestMessage({
    phoneE164: body.phone,
    text: body.text,
    adminUserId: new Types.ObjectId(admin.id),
    idempotencyKey: key.data,
    requestId: ctx.requestId,
  });
  return ok<QueueMessageResponse>(ctx, result, result.duplicate ? 200 : 202);
});
