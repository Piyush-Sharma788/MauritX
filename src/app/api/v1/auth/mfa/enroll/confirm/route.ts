import { mfaCodeSchema } from "@/features/auth/mfa";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { confirmMfaEnrollment } from "@/server/services/mfa";

/** POST /api/v1/auth/mfa/enroll/confirm: `{ code }`. Turns MFA on and returns ten recovery codes, shown once. */
export const POST = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, mfaCodeSchema);
  return ok(ctx, await confirmMfaEnrollment(user.id, user.sessionId, body.code, ctx));
});
