import type { CurrentUserResponse } from "@/features/auth/schemas";
import { AppError } from "@/lib/api/errors";
import { apiRoute, ok } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/current-user";

/** GET /api/v1/auth/me: the signed-in user's own account summary. */
export const GET = apiRoute(
  async (_request, ctx) => {
    const user = await getCurrentUser();
    if (!user) throw new AppError(401, "UNAUTHENTICATED", "Please sign in to continue.");
    return ok<CurrentUserResponse>(ctx, {
      user: {
        ...user,
        phoneVerifiedAt: user.phoneVerifiedAt.toISOString(),
        createdAt: user.createdAt.toISOString(),
      },
    });
  },
  { checkOrigin: false },
);
