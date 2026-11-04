import { Types } from "mongoose";
import { adminStatusSchema } from "@/features/requests/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { readPublicRequestId } from "@/server/requests/http";
import { adminUpdateStatus } from "@/server/requests/service";

/** POST /api/v1/admin/requests/:publicRequestId/status: verify, update, cancel or close. Admin only. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, adminStatusSchema);
  await adminUpdateStatus(id, body.status, body.note || undefined, new Types.ObjectId(admin.id), ctx);
  return ok(ctx, { status: body.status });
});
