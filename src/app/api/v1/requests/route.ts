import { createRequestSchema } from "@/features/requests/schemas";
import type { CreateRequestResponse } from "@/features/requests/types";
import { idempotencyKeySchema } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { createRequest } from "@/server/requests/service";

/**
 * POST /api/v1/requests: create an emergency blood request. No account needed.
 * Requires an Idempotency-Key header; a retry returns the original response.
 */
export const POST = apiRoute(async (request, ctx) => {
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key") ?? undefined);
  if (!key.success) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", key.error.issues[0].message);
  const body = await parseJsonBody(request, createRequestSchema);
  const result = await createRequest(body, key.data, ctx);
  return ok<CreateRequestResponse>(ctx, result, result.replayed ? 200 : 201);
});
