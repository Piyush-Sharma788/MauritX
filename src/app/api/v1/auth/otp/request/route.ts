import { sendOtpBodySchema } from "@/features/auth/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requestOtp } from "@/server/services/otp";

/** POST /api/v1/auth/otp/request: issue a one-time code for an Indian mobile number. */
export const POST = apiRoute(async (request, ctx) => {
  const body = await parseJsonBody(request, sendOtpBodySchema);
  const result = await requestOtp({ phoneE164: body.phone, purpose: body.purpose }, ctx);
  return ok(ctx, result);
});
