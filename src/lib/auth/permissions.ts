/**
 * Admin roles and what each may do. Browser-safe and pure, so the same map
 * drives API checks, page gates and which controls the UI shows.
 *
 * - coordinator: runs emergencies day to day (verify and coordinate requests,
 *   review discovered institutions, record answers). Sees patient details
 *   when verifying, every view audit-logged.
 * - super_admin: also changes system-wide settings, WhatsApp pairing,
 *   institution verification (which grants WhatsApp access), dead jobs, the
 *   audit history and server error reports. Role changes and MFA resets are CLI-only (scripts/admin-role.ts).
 * - admin: the pre-split role, treated as super_admin until migrated.
 */

export const STAFF_ROLES = ["coordinator", "super_admin", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = [
  "admin.access",
  "requests.manage",
  "coordination.manage",
  "institutions.review",
  "institutions.verify",
  "operations.read",
  "operations.settings",
  "whatsapp.read",
  "whatsapp.manage",
  "messages.retry",
  "jobs.retry",
  "audit.read",
  "conversations.read",
  "errors.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const COORDINATOR: readonly Permission[] = [
  "admin.access",
  "requests.manage",
  "coordination.manage",
  "institutions.review",
  "operations.read",
  "whatsapp.read",
  "messages.retry",
  "conversations.read",
];

const GRANTS: Record<StaffRole, readonly Permission[]> = {
  coordinator: COORDINATOR,
  super_admin: PERMISSIONS,
  admin: PERMISSIONS,
};

export const isStaffRole = (role: string): role is StaffRole => (STAFF_ROLES as readonly string[]).includes(role);

export function can(role: string, permission: Permission): boolean {
  return isStaffRole(role) && GRANTS[role].includes(permission);
}

export const ROLE_LABELS: Record<StaffRole, string> = { coordinator: "Coordinator", super_admin: "Super admin", admin: "Admin (legacy, full access)" };
