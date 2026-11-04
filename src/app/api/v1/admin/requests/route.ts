import { z } from "zod";
import { BLOOD_GROUPS } from "@/features/donors/schemas";
import { publicRequestIdSchema, REQUEST_STATUSES } from "@/features/requests/schemas";
import type { AdminRequestList } from "@/features/requests/types";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { listRequests } from "@/server/requests/service";

const querySchema = z.object({
  q: publicRequestIdSchema.optional(),
  status: z.enum(REQUEST_STATUSES).optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  city: z.string().trim().min(1).max(60).optional(),
  cursor: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** GET /api/v1/admin/requests: stats plus a filtered, paginated list. Admin only. */
export const GET = apiRoute(async (request, ctx) => {
  await requireAdmin();
  const raw = Object.fromEntries([...request.nextUrl.searchParams].filter(([, v]) => v !== ""));
  const query = querySchema.safeParse(raw);
  if (!query.success) throw new AppError(422, "VALIDATION_ERROR", "Invalid filters.", { fields: { query: query.error.issues[0].message } });
  return ok<AdminRequestList>(ctx, await listRequests(query.data));
});
