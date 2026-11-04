import { Types } from "mongoose";
import { linkInstitutionSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { linkRequestInstitution } from "@/server/institutions/service";
import { readPublicRequestId } from "@/server/requests/http";

/** POST /api/v1/admin/requests/:id/institution: `{ institutionId | null }`. Links a verified institution. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, linkInstitutionSchema);
  await linkRequestInstitution(id, body.institutionId, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { institutionId: body.institutionId });
});
