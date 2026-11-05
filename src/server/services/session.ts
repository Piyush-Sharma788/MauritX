import "server-only";
import type { Types } from "mongoose";
import { isProduction } from "@/lib/env";
import { generateSessionToken, hashSessionToken } from "@/lib/security/crypto";
import { Session } from "@/server/models/session";
import { User, type UserDoc } from "@/server/models/user";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Limits beyond the 7-day cookie. Admin sessions see decrypted patient and
 * donor data, so they expire much sooner. All configurable.
 */
export function sessionLimits() {
  const num = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(process.env[name] ?? fallback);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    idleMs: num("SESSION_IDLE_HOURS", 72, 1, 168) * 60 * 60 * 1000,
    adminIdleMs: num("ADMIN_SESSION_IDLE_MINUTES", 120, 5, 24 * 60) * 60 * 1000,
    adminMaxAgeMs: num("ADMIN_SESSION_MAX_HOURS", 12, 1, 168) * 60 * 60 * 1000,
  };
}
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

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
  await Session.create({ tokenHash: hashSessionToken(token), userId, expiresAt, lastSeenAt: new Date() });
  return { token, expiresAt };
}

/** Returns the revoked session's user id, if the token belonged to an active session. */
export async function revokeSession(token: string, reason: "logout" | "rotated" = "logout"): Promise<Types.ObjectId | null> {
  const session = await Session.findOneAndUpdate(
    { tokenHash: hashSessionToken(token), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
    { lean: true },
  );
  return session?.userId ?? null;
}

export type SessionUser = UserDoc & { _id: Types.ObjectId };

/** Resolves a cookie token to an active user, or null. */
export async function findSessionUser(token: string | undefined, now = new Date()): Promise<SessionUser | null> {
  if (!token || token.length > 128) return null;
  const session = await Session.findOne({
    tokenHash: hashSessionToken(token),
    revokedAt: null,
    expiresAt: { $gt: now },
  }).lean();
  if (!session) return null;
  const user = await User.findOne({ _id: session.userId, status: { $in: ["active", "paused"] } }).lean();
  if (!user) return null;

  const limits = sessionLimits();
  const createdAt = (session as { createdAt?: Date }).createdAt ?? now;
  const lastSeen = session.lastSeenAt ?? createdAt;
  const admin = user.role === "admin";
  const expired: "idle" | "max_age" | null =
    admin && now.getTime() - createdAt.getTime() > limits.adminMaxAgeMs ? "max_age"
    : now.getTime() - lastSeen.getTime() > (admin ? limits.adminIdleMs : limits.idleMs) ? "idle"
    : null;
  if (expired) {
    await Session.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: now, revokedReason: expired } });
    return null;
  }
  if (now.getTime() - lastSeen.getTime() > TOUCH_INTERVAL_MS) {
    await Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: now } });
  }
  return user;
}

/**
 * Ends every session of a user, e.g. after a role or phone change, so a
 * stolen or stale session can't keep (or gain) privileges. `keepTokenHash`
 * spares the session that made the change.
 */
export async function revokeAllSessions(userId: Types.ObjectId, reason: "role_changed" | "phone_changed", keepToken?: string): Promise<number> {
  const result = await Session.updateMany(
    { userId, revokedAt: null, ...(keepToken ? { tokenHash: { $ne: hashSessionToken(keepToken) } } : {}) },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return result.modifiedCount;
}
