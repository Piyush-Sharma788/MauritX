import { donorProfileUpdateSchema } from "@/features/donors/schemas";
import type { DonorOverview, DonorProfileView } from "@/features/donors/types";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { getDonorOverview, updateDonorProfile } from "@/server/donors/service";

/** GET /api/v1/donors/me: the signed-in user's donor overview (profile may be null). */
export const GET = apiRoute(
  async (_request, ctx) => {
    const user = await requireUser();
    return ok<DonorOverview>(ctx, await getDonorOverview(user.id));
  },
  { checkOrigin: false },
);

/** PATCH /api/v1/donors/me: update own profile fields. */
export const PATCH = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, donorProfileUpdateSchema);
  return ok<DonorProfileView>(ctx, await updateDonorProfile(user.id, body, ctx.requestId));
});
