import "server-only";
import type { Types } from "mongoose";
import { isProduction } from "@/lib/env";
import { generateSessionToken, hashSessionToken } from "@/lib/security/crypto";
import { Session } from "@/server/models/session";
import { User, type UserDoc } from "@/server/models/user";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** `__Host-` pins the cookie to our origin over HTTPS; plain name for http://localhost. */
export const sessionCookieName = () => (isProduction() ? "__Host-marutix_session" : "marutix_session");

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export async function createSession(userId: Types.ObjectId): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await Session.create({ tokenHash: hashSessionToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/** Returns the revoked session's user id, if the token belonged to an active session. */
export async function revokeSession(token: string): Promise<Types.ObjectId | null> {
  const session = await Session.findOneAndUpdate(
    { tokenHash: hashSessionToken(token), revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { lean: true },
  );
  return session?.userId ?? null;
}

export type SessionUser = UserDoc & { _id: Types.ObjectId };

/** Resolves a cookie token to an active user, or null. */
export async function findSessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 128) return null;
  const session = await Session.findOne({
    tokenHash: hashSessionToken(token),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!session) return null;
  const user = await User.findOne({ _id: session.userId, status: { $in: ["active", "paused"] } }).lean();
  return user ?? null;
}
