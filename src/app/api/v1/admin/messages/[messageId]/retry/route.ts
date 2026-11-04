import { Types } from "mongoose";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { retryFailedAlert } from "@/server/coordination/alerts";

/** POST /api/v1/admin/messages/:messageId/retry: re-queue a failed alert that certainly wasn't delivered. Admin only; audited. */
export const POST = apiRoute(async (_request, ctx, route) => {
  const admin = await requireAdmin();
  const { messageId } = await route.params;
  return ok(ctx, await retryFailedAlert(messageId ?? "", new Types.ObjectId(admin.id), ctx.requestId));
});
