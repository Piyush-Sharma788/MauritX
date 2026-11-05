import "server-only";
import QRCode from "qrcode";
import { Types } from "mongoose";
import { isStaffRole } from "@/lib/auth/permissions";
import type { ApiContext } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, encryptPii, hashRecoveryCode } from "@/lib/security/crypto";
import { generateRecoveryCodes, generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/security/totp";
import { Session } from "@/server/models/session";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";
import { enforceRateLimit } from "@/server/services/rate-limit";
import { revokeAllSessions } from "@/server/services/session";

/**
 * Mandatory two-factor authentication for staff (coordinators and super
 * admins): an authenticator app (TOTP) plus ten single-use recovery codes.
 * A staff session can reach admin pages and APIs only after this step.
 */

// Every attempt counts. Three codes are valid at any moment (±1 step), so the daily cap is
// what keeps long-run guessing negligible: 20 a day is ~6 in 100,000 per day.
const LIMITS = {
  perUser: { scope: "mfa-verify:user", limit: 5, windowSeconds: 15 * 60 },
  perUserDaily: { scope: "mfa-verify:user-day", limit: 20, windowSeconds: 24 * 60 * 60 },
  perIp: { scope: "mfa-verify:ip", limit: 20, windowSeconds: 15 * 60 },
};

async function enforceMfaLimits(userId: Types.ObjectId, ip: string, now: Date) {
  await enforceRateLimit(LIMITS.perUser, userId.toString(), now);
  await enforceRateLimit(LIMITS.perUserDaily, userId.toString(), now);
  await enforceRateLimit(LIMITS.perIp, ip, now);
}

async function loadStaff(userId: string) {
  await connectToDatabase();
  const user = Types.ObjectId.isValid(userId) ? await User.findById(userId).lean() : null;
  if (!user || !isStaffRole(user.role)) throw new AppError(403, "FORBIDDEN", "Two-factor authentication is for MarutiX staff accounts.");
  return user;
}

/** Starts (or restarts) enrollment: a new secret, shown once as a QR code and text. */
export async function startMfaEnrollment(userId: string, accountLabel: string, ctx: Pick<ApiContext, "requestId">) {
  const user = await loadStaff(userId);
  if (user.mfa?.enabledAt) throw new AppError(409, "CONFLICT", "Two-factor authentication is already set up. Ask a super admin to reset it if you lost your device.");
  const secret = generateTotpSecret();
  await User.updateOne({ _id: user._id }, { $set: { "mfa.pendingSecretEncrypted": encryptPii(secret) } });
  await recordAudit({ action: "auth.mfa.enrollment_started", outcome: "success", requestId: ctx.requestId, actorUserId: user._id });
  const uri = otpauthUri(secret, accountLabel);
  return { secret, otpauthUri: uri, qrSvg: await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) };
}

async function markSessionVerified(sessionId: string, userId: Types.ObjectId, now: Date) {
  const result = await Session.updateOne({ _id: sessionId, userId, revokedAt: null }, { $set: { mfaVerifiedAt: now } });
  if (result.matchedCount !== 1) throw new AppError(401, "UNAUTHENTICATED", "Please sign in again.");
}

/** Confirms enrollment with a first code; returns the recovery codes (shown once). */
export async function confirmMfaEnrollment(userId: string, sessionId: string, code: string, ctx: ApiContext, now = new Date()) {
  const user = await loadStaff(userId);
  await enforceMfaLimits(user._id, ctx.ip, now);
  if (user.mfa?.enabledAt) throw new AppError(409, "CONFLICT", "Two-factor authentication is already set up.");
  if (!user.mfa?.pendingSecretEncrypted) throw new AppError(409, "CONFLICT", "Start the setup again.");
  const secret = decryptPii(user.mfa.pendingSecretEncrypted);
  const step = verifyTotp(secret, code, now);
  if (step === null) {
    await recordAudit({ action: "auth.mfa.failed", outcome: "failure", requestId: ctx.requestId, actorUserId: user._id, resourceId: "enrollment" });
    throw new AppError(400, "MFA_INVALID", "That code doesn't match. Check the time on your phone and try the newest code.");
  }
  const codes = generateRecoveryCodes();
  const result = await User.updateOne(
    { _id: user._id, "mfa.enabledAt": null, "mfa.pendingSecretEncrypted": user.mfa.pendingSecretEncrypted },
    {
      $set: { "mfa.secretEncrypted": user.mfa.pendingSecretEncrypted, "mfa.enabledAt": now, "mfa.lastUsedStep": step, "mfa.recoveryCodeHashes": codes.map(hashRecoveryCode) },
      $unset: { "mfa.pendingSecretEncrypted": 1 },
    },
  );
  if (result.modifiedCount !== 1) throw new AppError(409, "CONFLICT", "Setup changed just now. Start again.");
  await markSessionVerified(sessionId, user._id, now);
  await recordAudit({ action: "auth.mfa.enrolled", outcome: "success", requestId: ctx.requestId, actorUserId: user._id });
  return { recoveryCodes: codes };
}

/** The second factor for this session: an authenticator code, or one recovery code. */
export async function verifyMfa(userId: string, sessionId: string, input: { code?: string; recoveryCode?: string }, ctx: ApiContext, now = new Date()) {
  const user = await loadStaff(userId);
  await enforceMfaLimits(user._id, ctx.ip, now);
  if (!user.mfa?.enabledAt || !user.mfa.secretEncrypted) throw new AppError(409, "CONFLICT", "Set up two-factor authentication first.");

  let accepted = false;
  if (input.code) {
    const step = verifyTotp(decryptPii(user.mfa.secretEncrypted), input.code, now, user.mfa.lastUsedStep ?? null);
    if (step !== null) {
      // Atomic: two requests with the same code can't both succeed.
      const used = await User.updateOne({ _id: user._id, $or: [{ "mfa.lastUsedStep": { $lt: step } }, { "mfa.lastUsedStep": null }] }, { $set: { "mfa.lastUsedStep": step } });
      accepted = used.modifiedCount === 1;
    }
  } else if (input.recoveryCode) {
    const used = await User.updateOne({ _id: user._id, "mfa.recoveryCodeHashes": hashRecoveryCode(input.recoveryCode) }, { $pull: { "mfa.recoveryCodeHashes": hashRecoveryCode(input.recoveryCode) } });
    accepted = used.modifiedCount === 1;
    if (accepted) await recordAudit({ action: "auth.mfa.recovery_code_used", outcome: "success", requestId: ctx.requestId, actorUserId: user._id });
  }

  if (!accepted) {
    await recordAudit({ action: "auth.mfa.failed", outcome: "failure", requestId: ctx.requestId, actorUserId: user._id });
    throw new AppError(400, "MFA_INVALID", "That code isn't valid. Use the newest code from your authenticator app, or an unused recovery code.");
  }
  await markSessionVerified(sessionId, user._id, now);
  await recordAudit({ action: "auth.mfa.verified", outcome: "success", requestId: ctx.requestId, actorUserId: user._id });
  const remaining = (await User.findById(user._id, { "mfa.recoveryCodeHashes": 1 }).lean())?.mfa?.recoveryCodeHashes?.length ?? 0;
  return { recoveryCodesRemaining: remaining };
}

/** CLI only (a lost device): removes MFA and signs the user out everywhere. */
export async function resetMfa(userId: Types.ObjectId, requestId: string) {
  await User.updateOne({ _id: userId }, { $unset: { mfa: 1 } });
  const ended = await revokeAllSessions(userId, "mfa_reset");
  await recordAudit({ action: "auth.mfa.reset", outcome: "success", requestId, actorUserId: userId });
  return ended;
}
