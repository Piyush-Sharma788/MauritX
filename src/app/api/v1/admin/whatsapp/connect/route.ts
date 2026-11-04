import { Types } from "mongoose";
import { connectBodySchema } from "@/features/whatsapp/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { whatsappWorker } from "@/lib/whatsapp-web/worker-client";
import { recordAudit } from "@/server/services/audit";

/** POST /api/v1/admin/whatsapp/connect: start, restore or (with `restart`) reconnect the client. Admin only. */
export const POST = apiRoute(async (request, ctx) => {
  const admin = await requireAdmin();
  const body = await parseJsonBody(request, connectBodySchema);
  const result = await whatsappWorker.connect(body.restart);
  await recordAudit({
    action: "whatsapp.connect_requested",
    outcome: "success",
    requestId: ctx.requestId,
    actorUserId: new Types.ObjectId(admin.id),
  });
  return ok(ctx, result, 202);
});
