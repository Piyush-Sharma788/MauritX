import { Types } from "mongoose";
import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { listConversations } from "@/server/admin/operations";

const querySchema = z.object({ cursor: z.string().regex(/^[a-f0-9]{24}$/).optional() });

/** GET /api/v1/admin/conversations?cursor=: bot conversation metadata (no message content exists). Admin only; audited. */
export const GET = apiRoute(async (request, ctx) => {
  const admin = await requireAdmin();
  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) throw new AppError(422, "VALIDATION_ERROR", "Invalid cursor.");
  return ok(ctx, await listConversations(new Types.ObjectId(admin.id), ctx.requestId, query.data.cursor));
});
