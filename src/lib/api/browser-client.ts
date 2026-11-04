import type { ApiErrorBody } from "@/lib/api/errors";

/** Browser-side JSON client for MarutiX APIs. UI components never call fetch directly. */

export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; error: ApiErrorBody; status: number };

const NETWORK_ERROR: ApiErrorBody = {
  code: "SERVICE_UNAVAILABLE",
  message: "We couldn't reach MarutiX. Check your connection and try again.",
};

export async function apiRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }

  const payload = (await response.json().catch(() => null)) as { data: T | null; error: ApiErrorBody | null } | null;
  if (response.ok && payload?.data) return { ok: true, data: payload.data, status: response.status };
  return {
    ok: false,
    status: response.status,
    error: payload?.error ?? { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  };
}
