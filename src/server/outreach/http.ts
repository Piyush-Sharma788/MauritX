import "server-only";
import type { NextRequest } from "next/server";
import { TRACKING_TOKEN } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import type { ApiContext } from "@/lib/api/handler";
import { enforceRateLimit } from "@/server/services/rate-limit";

/** Institution response tokens travel in a header on API calls. */
export async function readOutreachToken(request: NextRequest, ctx: ApiContext): Promise<string> {
  await enforceRateLimit({ scope: "outreach-respond:ip", limit: 30, windowSeconds: 15 * 60 }, ctx.ip);
  const token = request.headers.get("x-outreach-token") ?? "";
  if (!TRACKING_TOKEN.test(token)) throw new AppError(404, "NOT_FOUND", "This link isn't valid.");
  return token;
}
