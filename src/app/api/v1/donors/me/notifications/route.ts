import type { DonorAlertsResponse } from "@/features/donors/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { listDonorAlerts } from "@/server/donors/service";

/** GET /api/v1/donors/me/notifications: the donor's recent emergency alerts (no message content). */
export const GET = apiRoute(
  async (_request, ctx) => {
    const user = await requireUser();
    return ok<DonorAlertsResponse>(ctx, { alerts: await listDonorAlerts(user.id) });
  },
  { checkOrigin: false },
);
