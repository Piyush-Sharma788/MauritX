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
import { reportError } from "@/server/monitoring/report";
import { getAiConfig } from "@/lib/ai/config";
import { validateServerConfiguration } from "@/lib/security/config-check";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { getWhatsAppMediaConfig } from "@/lib/whatsapp/media-config";
import { dispatchOne, recordDeliveryAck } from "@/server/messaging/dispatcher";
import { SendPacer } from "@/server/messaging/pacing";
import { handleInboundMessage } from "@/server/messaging/inbound";
import { getMessagingSettings } from "@/server/settings/service";
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

/** A sleep that a new inbound message can cut short, so its replies go out at once. */
function wakeableSleep() {
  let wake: (() => void) | null = null;
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        if (ms <= 0) return resolve();
        const timer = setTimeout(() => ((wake = null), resolve()), ms);
        wake = () => (clearTimeout(timer), (wake = null), resolve());
      }),
    wake: () => wake?.(),
  };
}
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");

async function main() {
  // Fail fast on misconfiguration rather than on the first message.
  validateServerConfiguration("whatsapp-worker");
  const ai = getAiConfig();
  getCoordinationConfig();
  getWhatsAppMediaConfig();
  const baseConfig = getWhatsAppWebConfig();
  const config = { ...baseConfig, sessionDir: resolveSessionDir(baseConfig.sessionDir) };
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  await connectToDatabase();
  if (!(await acquireLease(owner))) {
    logger.error("whatsapp.worker.lease_held", { detail: "Another WhatsApp worker is running. Exiting." });
    await mongoose.disconnect();
    process.exit(1);
  }
  logger.info("whatsapp.worker.started", { owner, aiProvider: ai.provider });

  const idle = wakeableSleep();
  const manager = new WhatsAppSessionManager(config, owner, {
    onInbound: async (message) => {
      const outcome = await handleInboundMessage(message);
      logger.info("whatsapp.inbound_processed", { outcome, type: message.input.type });
      // Replies were just queued: don't wait for the next poll.
      idle.wake();
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
  process.on("unhandledRejection", (error) => void reportError(error, { source: "whatsapp_worker", event: "whatsapp.worker.unhandled_rejection" }));

  // Restore the saved session after a restart; otherwise wait for an admin.
  if (manager.hasSavedSession()) {
    logger.info("whatsapp.session_restore");
    await manager.connect();
  } else {
    await writeConnection(owner, { state: "disconnected", busy: false });
  }

  // The admin "pause alerts" switch, re-read every few seconds.
  let alertsPaused = false;
  let settingsReadAt = 0;
  const refreshSettings = async () => {
    if (Date.now() - settingsReadAt < 5_000) return;
    try {
      alertsPaused = (await getMessagingSettings()).alertsPaused;
      settingsReadAt = Date.now();
    } catch (error) {
      // Fail closed: hold alerts until the setting can be read again.
      alertsPaused = true;
      logger.warn("whatsapp.settings_read_failed", { errorName: errorName(error) });
    }
  };

  // Outbox dispatcher: one message at a time, capped. Replies to someone who just wrote follow
  // each other after WHATSAPP_WEB_REPLY_INTERVAL_MS; proactive messages keep the conservative
  // WHATSAPP_WEB_MIN_SEND_INTERVAL_MS since the last send of any kind.
  const pacer = new SendPacer({
    replyIntervalMs: config.replyIntervalMs,
    proactiveIntervalMs: config.minSendIntervalMs,
    idlePollMs: IDLE_POLL_MS,
    rateLimitedPollMs: RATE_LIMITED_POLL_MS,
  });
  logger.info("whatsapp.dispatcher_pacing", { replyIntervalMs: config.replyIntervalMs, proactiveIntervalMs: config.minSendIntervalMs });
  while (running) {
    let wait = IDLE_POLL_MS;
    if (manager.isReady()) {
      try {
        await refreshSettings();
        const { outcome } = await dispatchOne(manager, {
          alertsPaused,
          maxMessagesPerHour: config.maxMessagesPerHour,
          maxRepliesPerHour: config.maxRepliesPerHour,
          testRecipients: config.testRecipients,
          proactiveAllowed: pacer.proactiveAllowed(Date.now()),
        });
        wait = pacer.delayAfter(outcome, Date.now());
      } catch (error) {
        await reportError(error, { source: "messaging", event: "whatsapp.dispatch_error" });
        wait = 5_000;
      }
    }
    // Only an idle wait is cut short by new inbound; pacing gaps are always kept.
    await (wait === IDLE_POLL_MS ? idle.sleep(wait) : new Promise((r) => setTimeout(r, wait)));
  }
}

main().catch(async (error: unknown) => {
  await reportError(error, { source: "whatsapp_worker", event: "whatsapp.worker.fatal" });
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
