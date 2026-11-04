import { verifyOtpBodySchema } from "@/features/auth/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { encryptPii } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { changePhoneNumber } from "@/server/donors/service";
import { verifyOtp } from "@/server/services/otp";

/** POST /api/v1/donors/me/phone/verify: verify the code and move the account to the new number. */
export const POST = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, verifyOtpBodySchema);
  const { phoneLookup } = await verifyOtp({ phoneE164: body.phone, code: body.code, purpose: "phone_change" }, ctx);
  await changePhoneNumber(user.id, phoneLookup, encryptPii(body.phone), ctx.requestId);
  return ok(ctx, { maskedPhone: maskPhone(body.phone) });
});
