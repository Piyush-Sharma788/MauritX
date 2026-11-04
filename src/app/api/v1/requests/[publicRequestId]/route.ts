import type { TrackedRequestView } from "@/features/requests/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { readPublicRequestId, readTrackingToken } from "@/server/requests/http";
import { getTrackedRequest } from "@/server/requests/service";

/** GET /api/v1/requests/:publicRequestId: tracking view. Requires an X-Tracking-Token header. */
export const GET = apiRoute(
  async (request, ctx, route) => {
    const token = await readTrackingToken(request, ctx);
    const id = await readPublicRequestId(route);
    return ok<TrackedRequestView>(ctx, await getTrackedRequest(token, id));
  },
  { checkOrigin: false },
);
