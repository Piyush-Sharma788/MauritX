import { Types } from "mongoose";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { retryDeadJob } from "@/server/jobs/queue";
import { recordAudit } from "@/server/services/audit";

/** POST /api/v1/admin/jobs/:jobId/retry: give a dead job a fresh set of attempts. Admin only; audited. */
export const POST = apiRoute(async (_request, ctx, route) => {
  const admin = await requireAdmin();
  const { jobId } = await route.params;
  await retryDeadJob(jobId ?? "");
  await recordAudit({ action: "jobs.retried", outcome: "success", requestId: ctx.requestId, actorUserId: new Types.ObjectId(admin.id), resourceType: "job", resourceId: jobId });
  return ok(ctx, { status: "queued" });
});
