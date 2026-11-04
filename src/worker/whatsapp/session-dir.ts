import path from "node:path";

/**
 * Resolves WHATSAPP_WEB_SESSION_DIR to an absolute path. Session files grant
 * full access to the linked WhatsApp account, so they must never live
 * anywhere a web server could serve them.
 */
export function resolveSessionDir(configured: string, cwd = process.cwd()): string {
  const sessionDir = path.resolve(cwd, configured);
  for (const forbidden of ["public", ".next", "src"]) {
    const root = path.resolve(cwd, forbidden);
    if (sessionDir === root || sessionDir.startsWith(root + path.sep)) {
      throw new Error(`WHATSAPP_WEB_SESSION_DIR must not be inside ./${forbidden}`);
    }
  }
  return sessionDir;
}
