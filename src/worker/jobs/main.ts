/**
 * MarutiX background jobs worker: institution discovery, outreach email and
 * zone-wise donor waves. Start with `npm run jobs:worker`. Safe to run more
 * than one: jobs are claimed atomically. It never touches WhatsApp directly;
 * WhatsApp messages go through the outbox that the WhatsApp worker drains.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import mongoose from "mongoose";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { getDiscoveryConfig } from "@/lib/discovery/config";
import { getEmailConfig } from "@/lib/email/config";
import { logger } from "@/lib/logger";
import { runOneJob } from "@/server/jobs/runner";

const IDLE_POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Fail fast on misconfiguration.
  const coordination = getCoordinationConfig();
  const discovery = getDiscoveryConfig();
  const email = getEmailConfig();
  await connectToDatabase();
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  logger.info("jobs.worker.started", { workerId, discovery: discovery.provider, email: email.provider, autostart: coordination.autostart });

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      if (!(await runOneJob(workerId))) await sleep(IDLE_POLL_MS);
    } catch (error) {
      logger.error("jobs.worker.loop_error", { errorName: error instanceof Error ? error.name : "UnknownError" });
      await sleep(5_000);
    }
  }
  logger.info("jobs.worker.stopping");
  await mongoose.disconnect();
}

main().catch(async (error: unknown) => {
  logger.error("jobs.worker.fatal", { errorName: error instanceof Error ? error.name : "UnknownError", errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined });
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
