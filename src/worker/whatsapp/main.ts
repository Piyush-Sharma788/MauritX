/**
 * MarutiX WhatsApp Web pilot worker (whatsapp-web.js).
 *
 * Runs as its own long-lived process. It owns the single WhatsApp Web
 * session, drains the notification outbox, and exposes a loopback-only
 * control channel to the admin API. Start with `npm run whatsapp:worker`.
 *
 * whatsapp-web.js is an unofficial WhatsApp Web client. This worker is for a
 * controlled pilot only; see WHATSAPP_BOT.md.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { dispatchNext, recordDeliveryAck } from "@/server/messaging/dispatcher";
import { handleInboundMessage } from "@/server/messaging/inbound";
import {
  acquireLease,
  HEARTBEAT_INTERVAL_MS,
  releaseLease,
  renewLease,
  writeConnection,
} from "@/server/whatsapp/connection-store";
import { startControlServer } from "@/worker/whatsapp/control-server";
import { resolveSessionDir } from "@/worker/whatsapp/session-dir";
import { WhatsAppSessionManager } from "@/worker/whatsapp/session-manager";

const IDLE_POLL_MS = 2_000;
const RATE_LIMITED_POLL_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");

async function main() {
  const baseConfig = getWhatsAppWebConfig();
  const config = { ...baseConfig, sessionDir: resolveSessionDir(baseConfig.sessionDir) };
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  await connectToDatabase();
  if (!(await acquireLease(owner))) {
    logger.error("whatsapp.worker.lease_held", { detail: "Another WhatsApp worker is running. Exiting." });
    await mongoose.disconnect();
    process.exit(1);
  }
  logger.info("whatsapp.worker.started", { owner });

  const manager = new WhatsAppSessionManager(config, owner, {
    onInbound: async (message) => {
      const outcome = await handleInboundMessage(message);
      logger.info("whatsapp.inbound_processed", { outcome, type: message.input.type });
    },
    onAck: (providerMessageId, ack) => recordDeliveryAck(providerMessageId, ack),
  });

  let running = true;
  const server = await startControlServer(config, manager);

  const shutdown = async (code: number) => {
    if (!running) return;
    running = false;
    logger.info("whatsapp.worker.stopping");
    clearInterval(heartbeat);
    server.close();
    await manager.shutdown();
    await writeConnection(owner, { state: "disconnected", busy: false, lastDisconnectedAt: new Date(), lastDisconnectReason: "WORKER_STOPPED" }).catch(() => {});
    await releaseLease(owner).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(code);
  };

  const heartbeat = setInterval(() => {
    renewLease(owner)
      .then((held) => {
        if (!held) {
          logger.error("whatsapp.worker.lease_lost");
          void shutdown(1);
        }
      })
      .catch((error: unknown) => logger.warn("whatsapp.worker.heartbeat_failed", { errorName: errorName(error) }));
  }, HEARTBEAT_INTERVAL_MS);

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("unhandledRejection", (error) => logger.error("whatsapp.worker.unhandled_rejection", { errorName: errorName(error) }));

  // Restore the saved session after a restart; otherwise wait for an admin.
  if (manager.hasSavedSession()) {
    logger.info("whatsapp.session_restore");
    await manager.connect();
  } else {
    await writeConnection(owner, { state: "disconnected", busy: false });
  }

  // Outbox dispatcher: one message at a time, paced and capped.
  while (running) {
    let wait = IDLE_POLL_MS;
    if (manager.isReady()) {
      try {
        const outcome = await dispatchNext(manager, {
          maxMessagesPerHour: config.maxMessagesPerHour,
          maxRepliesPerHour: config.maxRepliesPerHour,
          testRecipients: config.testRecipients,
        });
        if (outcome === "rate_limited") wait = RATE_LIMITED_POLL_MS;
        else if (outcome === "suppressed") wait = 0;
        else if (outcome !== "idle") wait = config.minSendIntervalMs;
      } catch (error) {
        logger.error("whatsapp.dispatch_error", { errorName: errorName(error) });
        wait = 5_000;
      }
    }
    await sleep(wait);
  }
}

main().catch(async (error: unknown) => {
  logger.error("whatsapp.worker.fatal", {
    errorName: errorName(error),
    errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
