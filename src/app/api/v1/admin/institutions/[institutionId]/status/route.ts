import { Types } from "mongoose";
import { institutionStatusSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { setInstitutionStatus } from "@/server/institutions/service";

/** POST /api/v1/admin/institutions/:id/status: `{ verificationStatus, note? }`. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const { institutionId } = await route.params;
  const body = await parseJsonBody(request, institutionStatusSchema);
  await setInstitutionStatus(institutionId ?? "", body.verificationStatus, body.note || undefined, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { verificationStatus: body.verificationStatus });
});
