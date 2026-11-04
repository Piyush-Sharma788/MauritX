import { apiRoute, ok } from "@/lib/api/handler";
import { connectToDatabase } from "@/lib/db/mongoose";
import { recordAudit } from "@/server/services/audit";
import { revokeSession, sessionCookieName, sessionCookieOptions } from "@/server/services/session";

/** POST /api/v1/auth/logout: revoke the current session and clear the cookie. Idempotent. */
export const POST = apiRoute(async (request, ctx) => {
  const token = request.cookies.get(sessionCookieName())?.value;
  if (token) {
    await connectToDatabase();
    const userId = await revokeSession(token);
    if (userId) {
      await recordAudit({ action: "auth.session.revoked", outcome: "success", requestId: ctx.requestId, actorUserId: userId });
    }
  }
  const response = ok(ctx, { signedOut: true });
  response.cookies.set(sessionCookieName(), "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
  return response;
});
