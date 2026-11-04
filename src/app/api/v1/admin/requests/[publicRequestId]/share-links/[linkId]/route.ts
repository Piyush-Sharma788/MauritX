import { Types } from "mongoose";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { readPublicRequestId } from "@/server/requests/http";
import { adminRevokeLink } from "@/server/requests/service";

/** DELETE /api/v1/admin/requests/:publicRequestId/share-links/:linkId: revoke any tracking link. Admin only. */
export const DELETE = apiRoute(async (_request, ctx, route) => {
  const admin = await requireAdmin();
  const id = await readPublicRequestId(route);
  const { linkId } = await route.params;
  await adminRevokeLink(id, linkId ?? "", new Types.ObjectId(admin.id), ctx);
  return ok(ctx, { revoked: true });
});
