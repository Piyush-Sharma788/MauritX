import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getCoordinationOverview } from "@/server/admin/coordination";

/** GET /api/v1/admin/coordination: live overview of every open request's coordination. Admin only. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin("admin.access");
  return ok(ctx, await getCoordinationOverview());
});
