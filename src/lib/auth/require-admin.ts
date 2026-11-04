import "server-only";
import { AppError } from "@/lib/api/errors";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";

/** Server-side RBAC for admin route handlers. Never rely on hidden UI alone. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  if (user.role !== "admin") throw new AppError(403, "FORBIDDEN", "You don't have access to this.");
  return user;
}
