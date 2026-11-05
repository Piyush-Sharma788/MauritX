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
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { getMessagingProviderName, getWhatsAppCloudConfig } from "@/lib/whatsapp/cloud-config";
import { validateServerConfiguration } from "@/lib/security/config-check";
import { runOneJob } from "@/server/jobs/runner";
import { CloudApiMessagingProvider } from "@/server/messaging/cloud-provider";
import { dispatchNext } from "@/server/messaging/dispatcher";
import { getMessagingSettings } from "@/server/settings/service";

const IDLE_POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Fail fast on misconfiguration.
  validateServerConfiguration("jobs-worker");
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

  // With the official Cloud API there is no browser session, so this worker drains the outbox too.
  const cloud = getMessagingProviderName() === "whatsapp_cloud" ? getWhatsAppCloudConfig() : null;
  const dispatching = cloud ? dispatchLoop(new CloudApiMessagingProvider(cloud), cloud.pacing, () => running) : Promise.resolve();

  while (running) {
    try {
      if (!(await runOneJob(workerId))) await sleep(IDLE_POLL_MS);
    } catch (error) {
      logger.error("jobs.worker.loop_error", { errorName: error instanceof Error ? error.name : "UnknownError" });
      await sleep(5_000);
    }
  }
  await dispatching;
  logger.info("jobs.worker.stopping");
  await mongoose.disconnect();
}

/** Outbox dispatcher for the Cloud API: same consent re-checks, caps, retries and TTL as the pilot. */
async function dispatchLoop(provider: CloudApiMessagingProvider, pacing: { maxMessagesPerHour: number; maxRepliesPerHour: number; minSendIntervalMs: number }, isRunning: () => boolean) {
  logger.info("whatsapp_cloud.dispatcher_started");
  while (isRunning()) {
    let wait = IDLE_POLL_MS;
    try {
      const { alertsPaused } = await getMessagingSettings();
      const outcome = await dispatchNext(provider, { maxMessagesPerHour: pacing.maxMessagesPerHour, maxRepliesPerHour: pacing.maxRepliesPerHour, testRecipients: testRecipients(), alertsPaused });
      if (outcome === "rate_limited") wait = 30_000;
      else if (outcome === "suppressed") wait = 0;
      else if (outcome !== "idle") wait = pacing.minSendIntervalMs;
    } catch (error) {
      logger.error("whatsapp_cloud.dispatch_error", { errorName: error instanceof Error ? error.name : "UnknownError" });
      wait = 5_000;
    }
    await sleep(wait);
  }
}

/** Admin test recipients, if the pilot's list is configured. */
function testRecipients(): Set<string> {
  try {
    return getWhatsAppWebConfig().testRecipients;
  } catch {
    return new Set();
  }
}

main().catch(async (error: unknown) => {
  logger.error("jobs.worker.fatal", { errorName: error instanceof Error ? error.name : "UnknownError", errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined });
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
