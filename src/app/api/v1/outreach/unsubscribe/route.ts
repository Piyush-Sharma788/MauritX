import { apiRoute, ok } from "@/lib/api/handler";
import { readOutreachToken } from "@/server/outreach/http";
import { unsubscribeOutreachEmail } from "@/server/outreach/service";

/** POST /api/v1/outreach/unsubscribe (X-Outreach-Token): stop MarutiX emails to the address this link was sent to. */
export const POST = apiRoute(async (request, ctx) => {
  const token = await readOutreachToken(request, ctx);
  return ok(ctx, await unsubscribeOutreachEmail(token));
});
