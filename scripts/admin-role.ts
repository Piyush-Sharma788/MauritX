/**
 * Grants or revokes the admin role for an existing MarutiX account.
 *
 *   npm run admin:grant -- +919876543210
 *   npm run admin:revoke -- +919876543210
 *
 * The person must have signed in at least once. Changes are audit-logged.
 */
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { phoneLookupToken } from "@/lib/security/crypto";
import { maskPhone, normalizeIndianMobile } from "@/lib/validation/phone";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";
import { revokeAllSessions } from "@/server/services/session";

async function main() {
  const [mode, rawPhone] = process.argv.slice(2);
  if ((mode !== "grant" && mode !== "revoke") || !rawPhone) {
    console.error("Usage: npm run admin:grant -- +91XXXXXXXXXX   |   npm run admin:revoke -- +91XXXXXXXXXX");
    process.exit(2);
  }
  const phone = normalizeIndianMobile(rawPhone);
  if (!phone) {
    console.error("Enter a valid Indian mobile number.");
    process.exit(2);
  }

  await connectToDatabase();
  const user = await User.findOneAndUpdate(
    { phoneLookup: phoneLookupToken(phone) },
    { $set: { role: mode === "grant" ? "admin" : "donor" } },
    { returnDocument: "after" },
  ).lean();

  if (!user) {
    console.error(`No account found for ${maskPhone(phone)}. Sign in once through the app first.`);
    process.exitCode = 1;
  } else {
    await recordAudit({
      action: mode === "grant" ? "admin.role_granted" : "admin.role_revoked",
      outcome: "success",
      requestId: randomUUID(),
      actorUserId: user._id,
      resourceType: "user",
      resourceId: user._id.toString(),
    });
    // Privilege changes always start from a fresh sign-in.
    const ended = await revokeAllSessions(user._id, "role_changed");
    console.log(`${maskPhone(phone)} is now role "${user.role}". Signed out of ${ended} session(s); they must sign in again.`);
  }
  await mongoose.disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
