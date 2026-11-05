/**
 * Staff access for existing MarutiX accounts. Run on the server; there is no web UI for this on purpose.
 *
 *   npm run admin:grant -- coordinator +919876543210
 *   npm run admin:grant -- super_admin +919876543210
 *   npm run admin:revoke -- +919876543210
 *   npm run admin:mfa-reset -- +919876543210   (lost authenticator: they set it up again at next sign-in)
 *   npm run admin:list
 *
 * The person must have signed in at least once. Every change signs them out
 * everywhere and is audit-logged. Accounts with the old "admin" role keep full
 * access as super admins; move them with admin:grant -- super_admin.
 */
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { STAFF_ROLES } from "@/lib/auth/permissions";
import { decryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { maskPhone, normalizeIndianMobile } from "@/lib/validation/phone";
import { User } from "@/server/models/user";
import { resetMfa } from "@/server/services/mfa";
import { setStaffRole, type AssignableRole } from "@/server/services/staff";

const USAGE = `Usage:
  admin-role grant <coordinator|super_admin> +91XXXXXXXXXX
  admin-role revoke +91XXXXXXXXXX
  admin-role mfa-reset +91XXXXXXXXXX
  admin-role list`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parsePhone(raw: string | undefined): string {
  const phone = raw ? normalizeIndianMobile(raw) : null;
  return phone ?? fail("Enter a valid Indian mobile number.\n\n" + USAGE);
}

async function findUser(phone: string) {
  const user = await User.findOne({ phoneLookup: phoneLookupToken(phone) }, { _id: 1, role: 1 }).lean();
  if (!user) {
    console.error(`No account found for ${maskPhone(phone)}. Sign in once through the app first.`);
    process.exitCode = 1;
  }
  return user;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const requestId = randomUUID();

  if (mode === "list") {
    await connectToDatabase();
    const staff = await User.find({ role: { $in: STAFF_ROLES } }, { role: 1, phoneEncrypted: 1, mfa: 1 }).lean();
    for (const u of staff) {
      console.log(`${maskPhone(decryptPii(u.phoneEncrypted))}  ${u.role}${u.role === "admin" ? " (legacy: full access)" : ""}  2FA ${u.mfa?.enabledAt ? "on" : "not set up"}`);
    }
    if (staff.length === 0) console.log("No staff accounts.");
    return;
  }

  if (mode === "grant") {
    const [role, rawPhone] = rest;
    if (role !== "coordinator" && role !== "super_admin") fail(USAGE);
    const phone = parsePhone(rawPhone);
    await connectToDatabase();
    const user = await findUser(phone);
    if (!user) return;
    const result = await setStaffRole(user._id, role as AssignableRole, requestId);
    console.log(`${maskPhone(phone)}: ${result?.previous} -> ${result?.role}. Signed out of ${result?.sessionsEnded ?? 0} session(s). They set up two-factor authentication at next sign-in if they haven't.`);
    return;
  }

  if (mode === "revoke") {
    const phone = parsePhone(rest[0]);
    await connectToDatabase();
    const user = await findUser(phone);
    if (!user) return;
    const result = await setStaffRole(user._id, null, requestId);
    console.log(`${maskPhone(phone)}: ${result?.previous} -> donor. Two-factor setup removed; signed out of ${result?.sessionsEnded ?? 0} session(s).`);
    return;
  }

  if (mode === "mfa-reset") {
    const phone = parsePhone(rest[0]);
    await connectToDatabase();
    const user = await findUser(phone);
    if (!user) return;
    const ended = await resetMfa(user._id, requestId);
    console.log(`${maskPhone(phone)}: two-factor authentication reset. Signed out of ${ended} session(s); they set it up again at next sign-in.`);
    return;
  }

  fail(USAGE);
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
