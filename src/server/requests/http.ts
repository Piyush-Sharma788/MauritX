import "server-only";
import type { NextRequest } from "next/server";
import { publicRequestIdSchema, TRACKING_TOKEN } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import type { ApiContext, RouteParams } from "@/lib/api/handler";
import { enforceRateLimit } from "@/server/services/rate-limit";

const notFound = () => new AppError(404, "NOT_FOUND", "We couldn't find that request.");

/** Tracking tokens travel in a header on API calls, never in API URLs or bodies. */
export async function readTrackingToken(request: NextRequest, ctx: ApiContext): Promise<string> {
  // 256-bit tokens can't be guessed; this limit just keeps scanners off the endpoint.
  await enforceRateLimit({ scope: "request-track:ip", limit: 120, windowSeconds: 60 }, ctx.ip);
  const token = request.headers.get("x-tracking-token") ?? "";
  if (!TRACKING_TOKEN.test(token)) throw notFound();
  return token;
}

export async function readPublicRequestId(route: RouteParams): Promise<string> {
  const { publicRequestId } = await route.params;
  const parsed = publicRequestIdSchema.safeParse(publicRequestId ?? "");
  if (!parsed.success) throw notFound();
  return parsed.data;
}
