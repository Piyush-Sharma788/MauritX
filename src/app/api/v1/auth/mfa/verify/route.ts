import { mfaVerifySchema } from "@/features/auth/mfa";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { verifyMfa } from "@/server/services/mfa";

/** POST /api/v1/auth/mfa/verify: `{ code }` or `{ recoveryCode }`. Completes staff sign-in for this session. */
export const POST = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, mfaVerifySchema);
  return ok(ctx, await verifyMfa(user.id, user.sessionId, body, ctx));
});
