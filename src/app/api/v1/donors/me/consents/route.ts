import { notificationActionSchema } from "@/features/donors/schemas";
import type { DonorProfileView } from "@/features/donors/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { changeNotifications } from "@/server/donors/service";

/**
 * POST /api/v1/donors/me/consents: emergency alert preferences.
 * `enable` requires explicit consent and the current notice version;
 * `opt_out` takes effect immediately.
 */
export const POST = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, notificationActionSchema);
  return ok<DonorProfileView>(ctx, await changeNotifications(user.id, body.action, "web", ctx.requestId));
});
