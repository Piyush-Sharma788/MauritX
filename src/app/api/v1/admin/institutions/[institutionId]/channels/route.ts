import { Types } from "mongoose";
import { channelUpdateSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { upsertChannel } from "@/server/institutions/service";

/** POST /api/v1/admin/institutions/:id/channels: `{ type, value, status }`. Adds an official contact. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin("institutions.review");
  const { institutionId } = await route.params;
  const body = await parseJsonBody(request, channelUpdateSchema);
  await upsertChannel(institutionId ?? "", null, body, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { added: true }, 201);
});
