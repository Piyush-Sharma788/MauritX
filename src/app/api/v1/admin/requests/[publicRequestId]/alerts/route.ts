import { Types } from "mongoose";
import { alertBatchSchema } from "@/features/coordination/schemas";
import type { AlertBatchResult } from "@/features/coordination/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { sendAlertBatch } from "@/server/coordination/alerts";
import { readPublicRequestId } from "@/server/requests/http";

/** POST /api/v1/admin/requests/:id/alerts: `{ matchingRunId }`. Queues the next small batch of alerts. Admin only; audited. 202. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, alertBatchSchema);
  return ok<AlertBatchResult>(ctx, await sendAlertBatch(id, body.matchingRunId, new Types.ObjectId(admin.id), ctx.requestId), 202);
});
