import { Types } from "mongoose";
import { createInstitutionSchema } from "@/features/coordination/schemas";
import type { InstitutionSummary } from "@/features/coordination/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createInstitution, listInstitutions } from "@/server/institutions/service";

/** GET /api/v1/admin/institutions: all institutions. Admin only. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin("admin.access");
  return ok<{ institutions: InstitutionSummary[] }>(ctx, { institutions: await listInstitutions() });
});

/** POST /api/v1/admin/institutions: add a hospital or blood bank (starts as pending). Admin only; audited. */
export const POST = apiRoute(async (request, ctx) => {
  const admin = await requireAdmin("institutions.review");
  const body = await parseJsonBody(request, createInstitutionSchema);
  return ok<InstitutionSummary>(ctx, await createInstitution(body, new Types.ObjectId(admin.id), ctx.requestId), 201);
});
