#!/usr/bin/env node
/**
 * MarutiX Production Supervisor
 * Runs Next.js Web Server, WhatsApp Worker, and Jobs Worker in a unified container.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

// Load local .env if present (in container/production, environment variables are injected directly)
if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

const dataDir = process.env.MARUTIX_DATA_DIR || (process.env.WHATSAPP_WEB_SESSION_DIR ? process.env.WHATSAPP_WEB_SESSION_DIR.replace(/\/whatsapp-session$/, "") : "/app/.data");
try {
  mkdirSync(dataDir, { recursive: true });
} catch {}

const children = [];
let shuttingDown = false;

function startProcess(name, cmd, args, env = {}) {
  const proc = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  proc.on("exit", (code, signal) => {
    console.error(`[${name}] exited with code ${code} (signal: ${signal})`);
    if (code !== 0 && !shuttingDown) {
      console.error(`[supervisor] ${name} died unexpectedly. Initiating shutdown.`);
      shutdown(code || 1);
    }
  });

  children.push({ name, proc });
  return proc;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[supervisor] Received termination signal, stopping all services...");

  for (const { name, proc } of children) {
    try {
      proc.kill("SIGTERM");
    } catch (e) {
      console.error(`[supervisor] Error stopping ${name}:`, e.message);
    }
  }

  setTimeout(() => {
    console.warn("[supervisor] Force killing remaining processes...");
    for (const { proc } of children) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    process.exit(exitCode);
  }, 10000);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

console.log("[supervisor] Starting MarutiX Production Services...");

const port = process.env.PORT || "3000";

// 1. Next.js Web Server
const nextBin = existsSync("./node_modules/.bin/next") ? "./node_modules/.bin/next" : "next";
startProcess("web", nextBin, ["start", "-p", port, "-H", "0.0.0.0"]);

// 2. Background Jobs Worker
const tsxBin = existsSync("./node_modules/.bin/tsx") ? "./node_modules/.bin/tsx" : "tsx";
startProcess("jobs", tsxBin, ["--conditions=react-server", "src/worker/jobs/main.ts"]);

// 3. WhatsApp Worker (if configured for whatsapp_web)
if (process.env.MESSAGING_PROVIDER !== "whatsapp_cloud") {
  startProcess("whatsapp", tsxBin, ["--conditions=react-server", "src/worker/whatsapp/main.ts"]);
}
