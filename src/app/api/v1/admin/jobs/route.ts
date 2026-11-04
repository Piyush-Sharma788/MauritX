import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { jobStats, listDeadJobs } from "@/server/jobs/queue";

/** GET /api/v1/admin/jobs: queue counts and dead-lettered jobs. Admin only. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin();
  return ok(ctx, { stats: await jobStats(), dead: await listDeadJobs() });
});
