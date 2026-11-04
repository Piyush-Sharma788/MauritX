import { verifyOtpBodySchema, type VerifyOtpResponse } from "@/features/auth/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { recordAudit } from "@/server/services/audit";
import { verifyOtp } from "@/server/services/otp";
import { createSession, revokeSession, sessionCookieName, sessionCookieOptions } from "@/server/services/session";
import { findOrCreateVerifiedUser } from "@/server/services/users";

/** POST /api/v1/auth/otp/verify: verify the code once and start a new session. */
export const POST = apiRoute(async (request, ctx) => {
  const body = await parseJsonBody(request, verifyOtpBodySchema);
  const { phoneLookup } = await verifyOtp({ phoneE164: body.phone, code: body.code, purpose: "login" }, ctx);
  const { user, created } = await findOrCreateVerifiedUser(body.phone, phoneLookup);

  // Session rotation: any session carried by this browser is replaced.
  const previousToken = request.cookies.get(sessionCookieName())?.value;
  if (previousToken) await revokeSession(previousToken);
  const session = await createSession(user._id);

  if (created) {
    await recordAudit({ action: "auth.user.created", outcome: "success", requestId: ctx.requestId, actorUserId: user._id });
  }
  await recordAudit({ action: "auth.session.created", outcome: "success", requestId: ctx.requestId, actorUserId: user._id });

  const response = ok<VerifyOtpResponse>(ctx, {
    user: { id: user._id.toString(), role: user.role },
    redirectTo: "/dashboard",
  });
  response.cookies.set(sessionCookieName(), session.token, sessionCookieOptions(session.expiresAt));
  return response;
});
