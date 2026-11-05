import { Types } from "mongoose";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireUser } from "@/lib/auth/require-user";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii } from "@/lib/security/crypto";
import { User } from "@/server/models/user";
import { requestOtp } from "@/server/services/otp";

/** POST /api/v1/account/deletion/otp: send a fresh code to the signed-in number before deleting the account. */
export const POST = apiRoute(async (_request, ctx) => {
  const user = await requireUser();
  await connectToDatabase();
  const record = await User.findById(new Types.ObjectId(user.id), { phoneEncrypted: 1 }).lean();
  if (!record) throw new Error("Signed-in user has no record");
  return ok(ctx, await requestOtp({ phoneE164: decryptPii(record.phoneEncrypted), purpose: "account_deletion" }, ctx));
});
