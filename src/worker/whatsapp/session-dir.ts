import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves WHATSAPP_WEB_SESSION_DIR to an absolute path. A leading `~/` means
 * the user's home directory. Session files grant full access to the linked
 * WhatsApp account, so they must never live anywhere a web server could serve
 * them.
 *
 * In development, keep them outside the project folder (the default is
 * ~/.marutix/whatsapp-session): Chromium writes to its profile constantly, and
 * `next dev` treats every write inside the project as a code change, so the
 * open page would rebuild and reload in a loop.
 */
export function resolveSessionDir(configured: string, cwd = process.cwd(), home = homedir()): string {
  const expanded = configured === "~" ? home : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured;
  const sessionDir = path.resolve(cwd, expanded);
  for (const forbidden of ["public", ".next", "src"]) {
    const root = path.resolve(cwd, forbidden);
    if (sessionDir === root || sessionDir.startsWith(root + path.sep)) {
      throw new Error(`WHATSAPP_WEB_SESSION_DIR must not be inside ./${forbidden}`);
    }
  }
  return sessionDir;
}
