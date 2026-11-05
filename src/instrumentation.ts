/**
 * Runs once when a Next.js server starts, before it handles requests.
 * Refuses to start with missing or unsafe configuration.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` imports this too; secrets aren't present (or needed) at build time.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { validateServerConfiguration } = await import("@/lib/security/config-check");
  try {
    validateServerConfiguration("web");
  } catch (error) {
    // Next.js would only log this and answer every request with 500; in production, stop so the
    // process manager and health checks see a failed start.
    console.error(error instanceof Error ? error.message : error);
    if (process.env.NODE_ENV === "production") process.exit(1);
    throw error;
  }
}
