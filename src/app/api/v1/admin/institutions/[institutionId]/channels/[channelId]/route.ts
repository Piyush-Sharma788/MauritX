import { Types } from "mongoose";
import { channelUpdateSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { upsertChannel } from "@/server/institutions/service";

/** PATCH /api/v1/admin/institutions/:id/channels/:channelId: correct a contact `{ type, value, status }`. Admin only; audited. */
export const PATCH = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin("institutions.review");
  const { institutionId, channelId } = await route.params;
  const body = await parseJsonBody(request, channelUpdateSchema);
  await upsertChannel(institutionId ?? "", channelId ?? "", body, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { updated: true });
});
