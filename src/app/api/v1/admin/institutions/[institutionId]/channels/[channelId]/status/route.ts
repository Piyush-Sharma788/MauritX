import { Types } from "mongoose";
import { channelStatusSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { setChannelStatus } from "@/server/institutions/service";

/** POST /api/v1/admin/institutions/:id/channels/:channelId/status: `{ status }`. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const { institutionId, channelId } = await route.params;
  const body = await parseJsonBody(request, channelStatusSchema);
  await setChannelStatus(institutionId ?? "", channelId ?? "", body.status, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { status: body.status });
});
