import { Types } from "mongoose";
import { matchingRunSchema } from "@/features/coordination/schemas";
import type { MatchingRunView } from "@/features/coordination/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { runMatching } from "@/server/matching/service";
import { readPublicRequestId } from "@/server/requests/http";

/** POST /api/v1/admin/requests/:id/matching: `{ radiusKm: 5 | 10 | 25 | 50 }`. Runs a deterministic donor search. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin("coordination.manage");
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, matchingRunSchema);
  return ok<MatchingRunView>(ctx, await runMatching(id, body.radiusKm, new Types.ObjectId(admin.id), ctx.requestId), 201);
});
