import "server-only";
import { notFound, redirect } from "next/navigation";
import { AppError } from "@/lib/api/errors";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";
import { can, isStaffRole, type Permission } from "@/lib/auth/permissions";

/**
 * Server-side RBAC for admin route handlers. Staff must have passed the
 * second factor in this session; the permission is checked against the role
 * stored now, so a role change takes effect on the next request.
 */
export async function requireAdmin(permission: Permission = "admin.access"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  if (!isStaffRole(user.role)) throw new AppError(403, "FORBIDDEN", "You don't have access to this.");
  if (!user.mfaVerified) {
    throw new AppError(403, "MFA_REQUIRED", user.mfaEnrolled ? "Enter the code from your authenticator app to continue." : "Set up two-factor authentication to continue.");
  }
  if (!can(user.role, permission)) throw new AppError(403, "FORBIDDEN", "Your role doesn't allow this.");
  return user;
}

/** The same gate for admin pages: sign-in, then the second factor, then the permission. Hides pages from everyone else. */
export async function requireAdminPage(permission: Permission = "admin.access"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!isStaffRole(user.role)) notFound();
  if (!user.mfaVerified) redirect("/admin/mfa");
  if (!can(user.role, permission)) notFound();
  return user;
}
