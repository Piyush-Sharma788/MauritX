import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { findSession, sessionCookieName } from "@/server/services/session";

export interface CurrentUser {
  id: string;
  role: string;
  status: string;
  maskedPhone: string;
  phoneVerifiedAt: Date;
  createdAt: Date;
  /** Staff only: an authenticator app is set up. */
  mfaEnrolled: boolean;
  /** Staff only: this session passed the second factor. */
  mfaVerified: boolean;
  sessionId: string;
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
  const found = await findSession(token);
  if (!found) return null;
  const { user, session } = found;
  return {
    id: user._id.toString(),
    role: user.role,
    status: user.status,
    maskedPhone: maskPhone(decryptPii(user.phoneEncrypted)),
    phoneVerifiedAt: user.phoneVerifiedAt,
    createdAt: (user as { createdAt?: Date }).createdAt ?? user.phoneVerifiedAt,
    mfaEnrolled: Boolean(user.mfa?.enabledAt),
    mfaVerified: Boolean(user.mfa?.enabledAt && session.mfaVerifiedAt),
    sessionId: session.id.toString(),
  };
});
