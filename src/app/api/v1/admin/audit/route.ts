import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { listAuditEvents } from "@/server/admin/operations";
import { AUDIT_ACTIONS } from "@/server/models/audit-log";

const querySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  cursor: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/v1/admin/audit?action=&cursor=&limit=: audit events, newest first. Admin only. */
export const GET = apiRoute(async (request, ctx) => {
  await requireAdmin("audit.read");
  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) throw new AppError(422, "VALIDATION_ERROR", "Invalid filter.");
  return ok(ctx, await listAuditEvents(query.data));
});
