import type { TrackedRequestView } from "@/features/requests/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { requesterUpdateStatus } from "@/server/requests/service";

/** POST /api/v1/requests/:publicRequestId/cancel: requester cancels (manage link only). */
export const POST = apiRoute(async (request, ctx, route) => {
  const token = await readTrackingToken(request, ctx);
  const id = await readPublicRequestId(route);
  return ok<TrackedRequestView>(ctx, await requesterUpdateStatus(token, id, "cancelled", ctx));
});
