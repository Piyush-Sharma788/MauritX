import { apiRoute, ok } from "@/lib/api/handler";
import { revealDonorContact } from "@/server/coordination/requester";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { requireManageLink } from "@/server/requests/service";

/** POST /api/v1/requests/:id/donors/:responseId/reveal: one consenting donor's contact (manage link only). Logged. */
export const POST = apiRoute(async (request, ctx, route) => {
  const token = await readTrackingToken(request, ctx);
  const id = await readPublicRequestId(route);
  const { request: record } = await requireManageLink(token, id);
  const { responseId } = await route.params;
  return ok(ctx, await revealDonorContact(record, responseId ?? ""));
});
