import { z } from "zod";
import type { MessageLogResponse } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { listRecentMessages } from "@/server/messaging/message-log";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^[a-f0-9]{24}$/).optional(),
});

/** GET /api/v1/admin/whatsapp/messages: recent message log (masked recipients, no bodies). Admin only. */
export const GET = apiRoute(async (request, ctx) => {
  await requireAdmin();
  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) throw new AppError(422, "VALIDATION_ERROR", "Invalid limit or cursor.");
  return ok<MessageLogResponse>(ctx, await listRecentMessages(query.data));
});
