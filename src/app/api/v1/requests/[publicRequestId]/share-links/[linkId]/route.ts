import { apiRoute, ok } from "@/lib/api/handler";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { revokeFamilyLink } from "@/server/requests/service";

/** DELETE /api/v1/requests/:publicRequestId/share-links/:linkId: revoke a family link (manage link only). */
export const DELETE = apiRoute(async (request, ctx, route) => {
  const token = await readTrackingToken(request, ctx);
  const id = await readPublicRequestId(route);
  const { linkId } = await route.params;
  await revokeFamilyLink(token, id, linkId ?? "", ctx);
  return ok(ctx, { revoked: true });
});
