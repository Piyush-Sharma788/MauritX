import { shareLinkSchema } from "@/features/requests/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { createFamilyLink } from "@/server/requests/service";

/** POST /api/v1/requests/:publicRequestId/share-links: a read-only, time-limited family link (manage link only). */
export const POST = apiRoute(async (request, ctx, route) => {
  const token = await readTrackingToken(request, ctx);
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, shareLinkSchema);
  return ok(ctx, await createFamilyLink(token, id, body.hours, ctx), 201);
});
