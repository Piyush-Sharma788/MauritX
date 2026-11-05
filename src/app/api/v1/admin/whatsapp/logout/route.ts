import { Types } from "mongoose";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { whatsappWorker } from "@/lib/whatsapp-web/worker-client";
import { recordAudit } from "@/server/services/audit";
import { ADMIN_RATE_LIMITS, enforceRateLimit } from "@/server/services/rate-limit";

/** POST /api/v1/admin/whatsapp/logout: unlink the device and delete the saved session. Admin only. */
export const POST = apiRoute(async (_request, ctx) => {
  const admin = await requireAdmin("whatsapp.manage");
  await enforceRateLimit(ADMIN_RATE_LIMITS.whatsappSession, admin.id);
  const result = await whatsappWorker.logout();
  await recordAudit({
    action: "whatsapp.logout_requested",
    outcome: "success",
    requestId: ctx.requestId,
    actorUserId: new Types.ObjectId(admin.id),
  });
  return ok(ctx, result);
});
