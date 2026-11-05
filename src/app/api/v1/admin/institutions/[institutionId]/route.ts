import type { InstitutionDetail } from "@/features/coordination/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getInstitutionDetail } from "@/server/institutions/service";

/** GET /api/v1/admin/institutions/:id: details, contacts (masked), availability reports and linked requests. Admin only. */
export const GET = apiRoute(async (_request, ctx, route) => {
  await requireAdmin("admin.access");
  const { institutionId } = await route.params;
  return ok<InstitutionDetail>(ctx, await getInstitutionDetail(institutionId ?? ""));
});
