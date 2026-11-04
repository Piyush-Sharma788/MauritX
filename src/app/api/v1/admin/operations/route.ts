import type { OperationsOverview } from "@/features/coordination/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getOperationsOverview } from "@/server/admin/operations";

/** GET /api/v1/admin/operations: live counts for the control centre. Admin only. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin();
  return ok<OperationsOverview>(ctx, await getOperationsOverview());
});
