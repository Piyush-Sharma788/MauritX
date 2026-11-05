import { Types } from "mongoose";
import { z } from "zod";
import { otpCodeSchema } from "@/features/auth/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii } from "@/lib/security/crypto";
import { User } from "@/server/models/user";
import { deleteAccount } from "@/server/services/account-deletion";
import { verifyOtp } from "@/server/services/otp";
import { sessionCookieName, sessionCookieOptions } from "@/server/services/session";

const bodySchema = z.strictObject({ code: otpCodeSchema, confirm: z.literal("DELETE", { error: "Type DELETE to confirm." }) });

/** POST /api/v1/account/deletion: `{ code, confirm: "DELETE" }`. Permanently deletes the signed-in account. */
export const POST = apiRoute(async (request, ctx) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, bodySchema);
  await connectToDatabase();
  const record = await User.findById(new Types.ObjectId(user.id), { phoneEncrypted: 1 }).lean();
  if (!record) throw new Error("Signed-in user has no record");
  await verifyOtp({ phoneE164: decryptPii(record.phoneEncrypted), code: body.code, purpose: "account_deletion" }, ctx);
  await deleteAccount(user.id, ctx.requestId);
  const response = ok(ctx, { deleted: true });
  response.cookies.set(sessionCookieName(), "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
  return response;
});
