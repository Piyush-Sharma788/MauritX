import { Types } from "mongoose";
import { coordinationUpdateSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { updateCoordination } from "@/server/coordination/responses";
import { readPublicRequestId } from "@/server/requests/http";

/** POST /api/v1/admin/requests/:id/responses/:responseId/status: `{ status, note? }`. Moves a donor response forward. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin("coordination.manage");
  const id = await readPublicRequestId(route);
  const { responseId } = await route.params;
  const body = await parseJsonBody(request, coordinationUpdateSchema);
  await updateCoordination(id, responseId ?? "", body.status, { type: "admin", userId: new Types.ObjectId(admin.id) }, body.note || undefined, ctx.requestId);
  return ok(ctx, { status: body.status });
});
