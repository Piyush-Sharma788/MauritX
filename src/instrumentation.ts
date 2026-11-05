/**
 * Runs once when a Next.js server starts, before it handles requests.
 * Refuses to start with missing or unsafe configuration.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("./instrumentation-node");
  await registerNode();
}

/**
 * Server errors Next.js catches outside our API wrapper (Server Components, Server Actions).
 * Uses the route's file path, never the request URL, which can carry tokens.
 */
export async function onRequestError(error: unknown, _request: { path: string; method: string }, context: { routePath: string; routeType: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : "";
  // redirect() and notFound() are control flow, not failures.
  if (digest.startsWith("NEXT_")) return;
  const { reportError } = await import("@/server/monitoring/report");
  await reportError(error, { source: context.routeType === "route" ? "api" : "render", event: `next.${context.routeType}_error`, where: context.routePath });
}
