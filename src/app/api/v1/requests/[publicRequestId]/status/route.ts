import { requesterStatusSchema } from "@/features/requests/schemas";
import type { TrackedRequestView } from "@/features/requests/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { requesterUpdateStatus } from "@/server/requests/service";

/** POST /api/v1/requests/:publicRequestId/status: requester reports partially fulfilled, fulfilled or cancelled (manage link only). */
export const POST = apiRoute(async (request, ctx, route) => {
  const token = await readTrackingToken(request, ctx);
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, requesterStatusSchema);
  return ok<TrackedRequestView>(ctx, await requesterUpdateStatus(token, id, body.status, ctx));
});
