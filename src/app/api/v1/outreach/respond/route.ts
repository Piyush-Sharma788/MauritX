import { institutionReplySchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { readOutreachToken } from "@/server/outreach/http";
import { recordInstitutionResponse } from "@/server/outreach/service";

/** POST /api/v1/outreach/respond (X-Outreach-Token): an institution answers an outreach message. */
export const POST = apiRoute(async (request, ctx) => {
  const token = await readOutreachToken(request, ctx);
  const body = await parseJsonBody(request, institutionReplySchema);
  await recordInstitutionResponse(token, body);
  return ok(ctx, { response: body.response });
});
