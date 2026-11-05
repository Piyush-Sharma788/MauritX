import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getRequestCoordination } from "@/server/coordination/admin";
import { readPublicRequestId } from "@/server/requests/http";

/** GET /api/v1/admin/requests/:id/coordination: alert counts, latest donor search and responses. Admin only. */
export const GET = apiRoute(async (_request, ctx, route) => {
  await requireAdmin("coordination.manage");
  return ok(ctx, await getRequestCoordination(await readPublicRequestId(route)));
});
