import { availabilitySchema } from "@/features/donors/schemas";
import type { DonorProfileView } from "@/features/donors/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { setAvailability } from "@/server/donors/service";

/** PATCH /api/v1/donors/me/availability: whether the donor can currently donate. */
export const PATCH = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, availabilitySchema);
  return ok<DonorProfileView>(ctx, await setAvailability(user.id, body.availableForRequests, ctx.requestId));
});
