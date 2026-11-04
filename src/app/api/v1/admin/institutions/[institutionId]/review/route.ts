import { Types } from "mongoose";
import { reviewInstitutionSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { reviewInstitution } from "@/server/institutions/service";

/** POST /api/v1/admin/institutions/:id/review: `{ status: approved | excluded, note? }`. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const { institutionId } = await route.params;
  const body = await parseJsonBody(request, reviewInstitutionSchema);
  await reviewInstitution(institutionId ?? "", body.status, body.note || undefined, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { status: body.status });
});
