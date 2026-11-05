/** Node.js-only startup work, imported by src/instrumentation.ts so the Edge bundle never sees it. */
export async function registerNode() {
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
