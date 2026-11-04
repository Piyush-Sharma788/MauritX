import "server-only";
import { AppError } from "@/lib/api/errors";
import { encryptPii } from "@/lib/security/crypto";
import { User } from "@/server/models/user";
import type { SessionUser } from "@/server/services/session";

const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * Returns the account for a verified phone number, creating it on first
 * sign-in. The unique `phoneLookup` index guarantees one account per number
 * even under concurrent verifications.
 */
export async function findOrCreateVerifiedUser(
  phoneE164: string,
  phoneLookup: string,
): Promise<{ user: SessionUser; created: boolean }> {
  const now = new Date();
  const upsert = () =>
    User.findOneAndUpdate(
      { phoneLookup },
      {
        $set: { phoneVerifiedAt: now },
        $setOnInsert: { phoneLookup, phoneEncrypted: encryptPii(phoneE164), role: "donor", status: "active" },
      },
      { upsert: true, returnDocument: "after", includeResultMetadata: true, lean: true },
    );

  let result;
  try {
    result = await upsert();
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    result = await upsert();
  }

  const user = result.value as SessionUser | null;
  if (!user) throw new Error("User upsert returned no document");
  if (user.status === "suspended" || user.status === "deleted") {
    throw new AppError(403, "ACCOUNT_UNAVAILABLE", "This account can't sign in right now. Please contact MarutiX support.");
  }
  return { user, created: Boolean(result.lastErrorObject?.upserted) };
}
