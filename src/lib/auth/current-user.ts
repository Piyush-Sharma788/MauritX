import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { findSessionUser, sessionCookieName } from "@/server/services/session";

export interface CurrentUser {
  id: string;
  role: string;
  status: string;
  maskedPhone: string;
  phoneVerifiedAt: Date;
  createdAt: Date;
}

/**
 * Data access layer for Server Components and Route Handlers. Returns a
 * narrow, display-safe view of the signed-in user, or null.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return null;
  // Session validity depends on the current time, so this must never be prerendered.
  await connection();
  await connectToDatabase();
  const user = await findSessionUser(token);
  if (!user) return null;
  return {
    id: user._id.toString(),
    role: user.role,
    status: user.status,
    maskedPhone: maskPhone(decryptPii(user.phoneEncrypted)),
    phoneVerifiedAt: user.phoneVerifiedAt,
    createdAt: (user as { createdAt?: Date }).createdAt ?? user.phoneVerifiedAt,
  };
});
