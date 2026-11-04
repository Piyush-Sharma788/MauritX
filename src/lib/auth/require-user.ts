import "server-only";
import { AppError } from "@/lib/api/errors";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";

/** Any signed-in, active user. Resource ownership is enforced by the caller using `user.id`. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  return user;
}
