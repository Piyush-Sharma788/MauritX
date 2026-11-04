import { donorContactLinkSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { createDonorContactsLink } from "@/server/coordination/requester";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { requireManageLink, trackingUrl } from "@/server/requests/service";

/**
 * POST /api/v1/requests/:id/contact-links: `{ hours: 6 | 24 | 72 }`. A short-lived
 * link showing consenting donors' contacts to one responsible person (manage link only).
 */
export const POST = apiRoute(async (request, ctx, route) => {
  const token = await readTrackingToken(request, ctx);
  const id = await readPublicRequestId(route);
  const body = await parseJsonBody(request, donorContactLinkSchema);
  const { request: record, link } = await requireManageLink(token, id);
  const created = await createDonorContactsLink(record, link.expiresAt, body.hours);
  return ok(ctx, { id: created.id, url: trackingUrl(created.token), expiresAt: created.expiresAt.toISOString() }, 201);
});
