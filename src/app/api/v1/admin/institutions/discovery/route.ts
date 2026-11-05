import { z } from "zod";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { ADMIN_RATE_LIMITS, enforceRateLimit } from "@/server/services/rate-limit";
import { AppError } from "@/lib/api/errors";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getDiscoveryConfig } from "@/lib/discovery/config";
import { discoveryAreasOverview } from "@/server/discovery/areas";
import { enqueueJob } from "@/server/jobs/queue";

/** GET /api/v1/admin/institutions/discovery: background area discovery (areas, last results, next runs). Admin only. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin("admin.access");
  return ok(ctx, await discoveryAreasOverview());
});

const actionSchema = z.strictObject({
  action: z.enum(["sweep", "refresh_area"]),
  areaKey: z.string().min(3).max(80).optional(),
});

/**
 * POST /api/v1/admin/institutions/discovery: `{ action: "sweep" }` queues a
 * sweep now; `{ action: "refresh_area", areaKey }` queues one area. The same
 * throttling and caps apply; no data is entered by hand. Admin only.
 */
export const POST = apiRoute(async (request, ctx) => {
  const admin = await requireAdmin("institutions.review");
  await enforceRateLimit(ADMIN_RATE_LIMITS.discovery, admin.id);
  const body = await parseJsonBody(request, actionSchema);
  const config = getDiscoveryConfig();
  if (config.provider === "none") throw new AppError(409, "CONFLICT", "Set DISCOVERY_PROVIDER to enable discovery.");
  const now = Date.now();
  if (body.action === "sweep") {
    await enqueueJob("discovery_sweep", `discovery_sweep:manual:${now}`, {}, { maxAttempts: 1 });
  } else {
    if (!body.areaKey) throw new AppError(400, "VALIDATION_ERROR", "areaKey is required.");
    await enqueueJob("discovery_area_refresh", `discovery_area:${body.areaKey}:manual:${now}`, { areaKey: body.areaKey }, { maxAttempts: 1 });
  }
  return ok(ctx, { queued: true }, 202);
});
