import type { FailedMessageView } from "@/features/coordination/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { listFailedMessages } from "@/server/admin/operations";

/** GET /api/v1/admin/operations/failed-messages: recent failures, masked, with which can be retried. Admin only. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin("operations.read");
  return ok<{ messages: FailedMessageView[] }>(ctx, { messages: await listFailedMessages() });
});
