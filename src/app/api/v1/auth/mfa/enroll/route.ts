import { apiRoute, ok } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { startMfaEnrollment } from "@/server/services/mfa";

/** POST /api/v1/auth/mfa/enroll: start authenticator setup (staff only). Returns the secret once, as a QR code and text. */
export const POST = apiRoute(async (_request, ctx) => {
  const user = await requireUser();
  return ok(ctx, await startMfaEnrollment(user.id, user.maskedPhone, ctx));
});
