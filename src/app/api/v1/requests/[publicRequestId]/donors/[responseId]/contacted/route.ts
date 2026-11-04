import { apiRoute, ok } from "@/lib/api/handler";
import { markDonorContacted } from "@/server/coordination/requester";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { requireManageLink } from "@/server/requests/service";

/** POST /api/v1/requests/:id/donors/:responseId/contacted: the requester contacted this donor (manage link only). */
export const POST = apiRoute(async (request, ctx, route) => {
  const token = await readTrackingToken(request, ctx);
  const id = await readPublicRequestId(route);
  const { request: record } = await requireManageLink(token, id);
  const { responseId } = await route.params;
  await markDonorContacted(record, responseId ?? "");
  return ok(ctx, { contacted: true });
});
