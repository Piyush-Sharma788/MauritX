import { Types } from "mongoose";
import { messagingSettingsSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { updateMessagingSettings } from "@/server/settings/service";

/** PATCH /api/v1/admin/operations/settings: `{ botEnabled?, alertsPaused? }`. Admin only; audited. */
export const PATCH = apiRoute(async (request, ctx) => {
  const admin = await requireAdmin();
  const body = await parseJsonBody(request, messagingSettingsSchema);
  return ok(ctx, await updateMessagingSettings(body, new Types.ObjectId(admin.id), ctx.requestId));
});
