import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { AppError, type ApiErrorBody } from "@/lib/api/errors";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { trustedProxyHops } from "@/lib/security/config-check";

const MAX_JSON_BODY_BYTES = 2_048;

export interface ApiContext {
  requestId: string;
  ip: string;
  userAgent: string;
}

type Envelope<T> = { data: T; error: null; meta: { requestId: string } } | {
  data: null;
  error: ApiErrorBody;
  meta: { requestId: string };
};

function json<T>(body: Envelope<T>, status: number, headers?: HeadersInit) {
  const response = NextResponse.json(body, { status, headers });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function ok<T>(ctx: ApiContext, data: T, status = 200) {
  return json<T>({ data, error: null, meta: { requestId: ctx.requestId } }, status);
}

function fail(ctx: ApiContext, error: AppError) {
  const headers: Record<string, string> = {};
  const retryAfter = error.details?.retryAfterSeconds;
  if (typeof retryAfter === "number") headers["Retry-After"] = String(retryAfter);
  return json(
    {
      data: null,
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      meta: { requestId: ctx.requestId },
    },
    error.status,
    headers,
  );
}

/**
 * Client IP for rate limiting. X-Forwarded-For is "client, proxy1, proxy2…":
 * entries on the left are whatever the client sent, so only the entry added
 * by our own outermost proxy can be trusted. With TRUSTED_PROXY_HOPS proxies
 * (default 1) that is the Nth entry from the right.
 */
export function clientIpFrom(headers: Headers, hops: number): string {
  const entries = (headers.get("x-forwarded-for") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (hops > 0 && entries.length) return entries[Math.max(0, entries.length - hops)];
  if (hops > 0) return headers.get("x-real-ip")?.trim() || "unknown";
  return "unknown";
}

function clientIp(request: NextRequest): string {
  return clientIpFrom(request.headers, trustedProxyHops());
}

/**
 * CSRF defence for cookie-authenticated mutations: browsers always send
 * Origin on cross-origin POSTs, so reject any Origin that is not ours.
 */
function assertSameOrigin(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") throw new AppError(403, "FORBIDDEN_ORIGIN", "This request is not allowed.");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(getEnv().APP_BASE_URL).origin) {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "This request is not allowed.");
  }
}

/** Reads a small JSON body and validates it. */
export async function parseJsonBody<S extends z.ZodType>(request: NextRequest, schema: S): Promise<z.output<S>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError(400, "BAD_REQUEST", "Expected a JSON request body.");
  }
  const raw = await request.text();
  if (raw.length > MAX_JSON_BODY_BYTES) throw new AppError(400, "BAD_REQUEST", "Request body is too large.");

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, "BAD_REQUEST", "Request body is not valid JSON.");
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join(".") || "body";
      fields[path] ??= issue.message;
    }
    throw new AppError(422, "VALIDATION_ERROR", "Please check the submitted fields.", { fields });
  }
  return result.data;
}

const DATABASE_UNAVAILABLE_ERRORS = new Set([
  "MongooseServerSelectionError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoNotConnectedError",
]);

function isDatabaseUnavailable(error: unknown): boolean {
  return error instanceof Error && DATABASE_UNAVAILABLE_ERRORS.has(error.name);
}

/** Next's route context; `params` resolves to the dynamic segments (empty for static routes). */
export interface RouteParams {
  params: Promise<Record<string, string>>;
}

type Handler = (request: NextRequest, ctx: ApiContext, route: RouteParams) => Promise<Response>;

/** Wraps a route handler with correlation IDs, origin checks and safe error mapping. */
export function apiRoute(handler: Handler, options: { checkOrigin?: boolean } = { checkOrigin: true }) {
  return async (request: NextRequest, route: RouteParams = { params: Promise.resolve({}) }): Promise<Response> => {
    const ctx: ApiContext = {
      requestId: randomUUID(),
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent")?.slice(0, 256) ?? "",
    };
    try {
      if (options.checkOrigin !== false) assertSameOrigin(request);
      return await handler(request, ctx, route);
    } catch (error) {
      if (error instanceof AppError) return fail(ctx, error);
      const errorName = error instanceof Error ? error.name : "UnknownError";
      if (isDatabaseUnavailable(error)) {
        logger.error("api.dependency_unavailable", { requestId: ctx.requestId, errorName, path: request.nextUrl.pathname });
        return fail(ctx, new AppError(503, "SERVICE_UNAVAILABLE", "MarutiX is temporarily unavailable. Please try again shortly."));
      }
      logger.error("api.unhandled_error", {
        requestId: ctx.requestId,
        errorName,
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
        path: request.nextUrl.pathname,
      });
      return fail(ctx, new AppError(500, "INTERNAL_ERROR", "Something went wrong. Please try again."));
    }
  };
}
