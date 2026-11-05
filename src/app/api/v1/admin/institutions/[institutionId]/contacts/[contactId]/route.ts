import { Types } from "mongoose";
import { contactStatusSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { setContactStatus } from "@/server/institutions/service";

/** POST /api/v1/admin/institutions/:id/contacts/:contactId: `{ status: "pending" | "verified" | "revoked" }`. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin("institutions.verify");
  const { institutionId, contactId } = await route.params;
  const body = await parseJsonBody(request, contactStatusSchema);
  await setContactStatus(institutionId ?? "", contactId ?? "", body.status, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { status: body.status });
});
