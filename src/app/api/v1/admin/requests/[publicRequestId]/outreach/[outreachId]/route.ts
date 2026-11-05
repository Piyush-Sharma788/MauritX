import { Types } from "mongoose";
import { outreachActionSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { readPublicRequestId } from "@/server/requests/http";
import { adminOutreachAction } from "@/server/outreach/service";

/** POST /api/v1/admin/requests/:id/outreach/:outreachId: `{ action: retry | send | cancel | record_response, ... }`. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin("coordination.manage");
  const id = await readPublicRequestId(route);
  const { outreachId } = await route.params;
  const body = await parseJsonBody(request, outreachActionSchema);
  await adminOutreachAction(id, outreachId ?? "", body, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { action: body.action });
});
