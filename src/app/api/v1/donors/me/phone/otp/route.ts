import { z } from "zod";
import { indianMobileSchema } from "@/features/auth/schemas";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { connectToDatabase } from "@/lib/db/mongoose";
import { phoneLookupToken } from "@/lib/security/crypto";
import { User } from "@/server/models/user";
import { requestOtp } from "@/server/services/otp";

const bodySchema = z.strictObject({ phone: indianMobileSchema });

/** POST /api/v1/donors/me/phone/otp: send a verification code to a new mobile number. */
export const POST = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const { phone } = await parseJsonBody(request, bodySchema);
  await connectToDatabase();
  const current = await User.findById(user.id, { phoneLookup: 1 }).lean();
  if (current?.phoneLookup === phoneLookupToken(phone)) {
    throw new AppError(422, "VALIDATION_ERROR", "This is already your mobile number.", { fields: { phone: "This is already your mobile number." } });
  }
  return ok(ctx, await requestOtp({ phoneE164: phone, purpose: "phone_change" }, ctx));
});
