import { Types } from "mongoose";
import { automationActionSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { controlAutomation } from "@/server/coordination/automation";
import { readPublicRequestId } from "@/server/requests/http";

/** POST /api/v1/admin/requests/:id/automation: `{ action: pause | resume | cancel | run_wave_now | rediscover | start }`. Admin only; audited. 202. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, automationActionSchema);
  await controlAutomation(id, body.action, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { action: body.action }, 202);
});
