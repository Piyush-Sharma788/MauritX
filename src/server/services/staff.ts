import "server-only";
import type { Types } from "mongoose";
import { isStaffRole } from "@/lib/auth/permissions";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";
import { revokeAllSessions } from "@/server/services/session";

export type AssignableRole = "coordinator" | "super_admin";

/**
 * Changes a user's staff role (null removes staff access). Every session ends
 * at once, so the new privileges apply only after a fresh sign-in and, for
 * staff, a fresh second factor. Leaving staff also removes the authenticator.
 */
export async function setStaffRole(userId: Types.ObjectId, role: AssignableRole | null, requestId: string) {
  const before = await User.findById(userId, { role: 1 }).lean();
  if (!before) return null;
  const next = role ?? "donor";
  if (before.role === next) return { previous: before.role, role: next, sessionsEnded: 0 };

  await User.updateOne({ _id: userId }, role ? { $set: { role } } : { $set: { role: "donor" }, $unset: { mfa: 1 } });
  const sessionsEnded = await revokeAllSessions(userId, "role_changed");
  const action = !isStaffRole(before.role) ? "admin.role_granted" : role ? "admin.role_changed" : "admin.role_revoked";
  // resourceId carries the new role so the audit trail shows what changed without any personal data.
  await recordAudit({ action, outcome: "success", requestId, actorUserId: userId, resourceType: "user_role", resourceId: next });
  return { previous: before.role, role: next, sessionsEnded };
}
