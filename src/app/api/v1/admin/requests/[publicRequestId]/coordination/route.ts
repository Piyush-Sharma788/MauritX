import { Types } from "mongoose";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getRequestCoordination } from "@/server/coordination/admin";
import { readPublicRequestId } from "@/server/requests/http";
import { recordAudit } from "@/server/services/audit";

/**
 * GET /api/v1/admin/requests/:id/coordination: alert counts, latest donor search and responses. Admin only.
 * Responses carry the phone numbers of donors who agreed to share them, so every such read is audited.
 */
export const GET = apiRoute(async (_request, ctx, route) => {
  const admin = await requireAdmin("coordination.manage");
  const id = await readPublicRequestId(route);
  const coordination = await getRequestCoordination(id);
  const disclosed = coordination.responses.filter((r) => r.donorPhone).length;
  if (disclosed > 0) {
    await recordAudit({
      action: "donor_contact.viewed_by_admin",
      outcome: "success",
      requestId: ctx.requestId,
      actorUserId: new Types.ObjectId(admin.id),
      resourceType: "emergency_request",
      resourceId: `${id}:${disclosed}`,
    });
  }
  return ok(ctx, coordination);
});
