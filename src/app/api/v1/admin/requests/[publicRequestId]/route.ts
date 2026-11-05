import { Types } from "mongoose";
import type { AdminRequestDetail } from "@/features/requests/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { readPublicRequestId } from "@/server/requests/http";
import { getAdminRequestDetail } from "@/server/requests/service";

/** GET /api/v1/admin/requests/:publicRequestId: full details for verification. Admin only; audited. */
export const GET = apiRoute(async (_request, ctx, route) => {
  const admin = await requireAdmin("requests.manage");
  const id = await readPublicRequestId(route);
  return ok<AdminRequestDetail>(ctx, await getAdminRequestDetail(id, new Types.ObjectId(admin.id), ctx));
});
