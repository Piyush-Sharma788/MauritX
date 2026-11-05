import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import WAWebJS from "whatsapp-web.js";
import type { WhatsAppConnectionState } from "@/features/whatsapp/types";
import { logger } from "@/lib/logger";
import { reportError } from "@/server/monitoring/report";
import { maskPhone } from "@/lib/validation/phone";
import type { WhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import type { InboundMessage } from "@/server/messaging/inbound";
import { MessagingError, type DeliveryAck, type MessagingProvider } from "@/server/messaging/provider";
import { writeConnection } from "@/server/whatsapp/connection-store";

const { Client, LocalAuth } = WAWebJS;

const CLIENT_ID = "marutix";
const PAIRING_TIMEOUT_MS = 5 * 60_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 30_000;

export class BusyError extends Error {
  constructor() {
    super("A WhatsApp connection change is already in progress");
    this.name = "BusyError";
  }
}

export interface SessionCallbacks {
  onInbound(message: InboundMessage): Promise<void>;
  onAck(providerMessageId: string, ack: DeliveryAck): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Masks a linked account number without assuming it is Indian. */
function maskAccountNumber(digits: string): string {
  if (/^91[6-9]\d{9}$/.test(digits)) return maskPhone(`+${digits}`);
  return digits.length > 5 ? `+${digits.slice(0, 2)}${"X".repeat(digits.length - 5)}${digits.slice(-3)}` : "Hidden";
}

/** "919876543210" -> "+919876543210" for Indian mobiles only; otherwise null. */
function indianE164FromDigits(digits: string): string | null {
  return /^91[6-9]\d{9}$/.test(digits) ? `+${digits}` : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function destroyClient(client: InstanceType<typeof Client>) {
  try {
    await withTimeout(client.destroy(), 15_000, () => new Error("destroy timeout"));
  } catch (error) {
    logger.warn("whatsapp.destroy_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

const ACK_MAP: Partial<Record<number, DeliveryAck>> = { [-1]: "error", 1: "server", 2: "device", 3: "read", 4: "read" };

/**
 * Owns the single whatsapp-web.js client for this worker: lifecycle, QR,
 * session persistence (LocalAuth), reconnection and sending. Every state
 * change is mirrored to MongoDB for the admin dashboard.
 */
export class WhatsAppSessionManager implements MessagingProvider {
  readonly name = "whatsapp_web" as const;

  private client: InstanceType<typeof Client> | null = null;
  private state: WhatsAppConnectionState = "disconnected";
  private qr: { value: string; generatedAt: Date } | null = null;
  private busy = false;
  private stopping = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pairingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: WhatsAppWebConfig,
    private readonly owner: string,
    private readonly callbacks: SessionCallbacks,
  ) {}

  /* ------------------------------ queries ------------------------------ */

  get connectionState(): WhatsAppConnectionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "connected" && this.client !== null;
  }

  currentQr() {
    return this.state === "qr_required" ? this.qr : null;
  }

  /** True only after a successful pairing; Chromium creates the profile folder before any QR is scanned. */
  hasSavedSession(): boolean {
    return existsSync(this.pairedMarker) && existsSync(this.profileDir);
  }

  private get profileDir() {
    return path.join(this.config.sessionDir, `session-${CLIENT_ID}`);
  }

  private get pairedMarker() {
    return path.join(this.config.sessionDir, "paired");
  }

  /* ------------------------------ commands ----------------------------- */

  /** Starts the client (restoring a saved session if present). No-op if already running unless `restart`. */
  async connect({ restart = false } = {}): Promise<void> {
    if (this.busy) throw new BusyError();
    const running = this.state === "connected" || this.state === "connecting" || this.state === "qr_required";
    if (running && !restart) return;
    await this.exclusive(async () => {
      this.clearReconnect();
      await this.teardown();
      await this.start();
    });
  }

  /** Unlinks the device from the phone and deletes the local session. */
  async logout(): Promise<void> {
    if (this.busy) throw new BusyError();
    await this.exclusive(async () => {
      this.clearReconnect();
      this.clearPairingTimer();
      // Detach first so the library's own "disconnected" event is ignored.
      const client = this.client;
      const wasConnected = this.state === "connected";
      this.client = null;
      this.qr = null;
      if (client && wasConnected) {
        try {
          await withTimeout(client.logout(), 20_000, () => new Error("logout timeout"));
        } catch (error) {
          logger.warn("whatsapp.logout_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
        }
      }
      if (client) await destroyClient(client);
      await this.removeSession();
      await this.setState("disconnected", {
        lastDisconnectedAt: new Date(),
        lastDisconnectReason: "LOGGED_OUT_BY_ADMIN",
        lastError: null,
        accountMaskedNumber: null,
        accountPushName: null,
        accountPlatform: null,
      });
    });
  }

  /** Stops the browser but keeps the saved session, for process shutdown. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.clearReconnect();
    this.clearPairingTimer();
    await this.teardown();
  }

  async sendText(phoneE164: string, body: string): Promise<{ providerMessageId: string }> {
    const client = this.client;
    if (!client || !this.isReady()) throw new MessagingError("NOT_CONNECTED", true);

    let numberId;
    try {
      numberId = await withTimeout(client.getNumberId(phoneE164.replace(/^\+/, "")), LOOKUP_TIMEOUT_MS, () => new MessagingError("SEND_TIMEOUT", true));
    } catch (error) {
      throw error instanceof MessagingError ? error : new MessagingError("SEND_FAILED", true);
    }
    if (!numberId) throw new MessagingError("NOT_ON_WHATSAPP", false);

    try {
      // A timeout here may still have delivered, so it is not retried (avoids duplicates).
      const message = await withTimeout(client.sendMessage(numberId._serialized, body), SEND_TIMEOUT_MS, () => new MessagingError("SEND_TIMEOUT", false));
      return { providerMessageId: message.id._serialized };
    } catch (error) {
      throw error instanceof MessagingError ? error : new MessagingError("SEND_FAILED", true);
    }
  }

  /* ------------------------------ internals ---------------------------- */

  private async exclusive(fn: () => Promise<void>) {
    this.busy = true;
    await this.persist({ busy: true });
    try {
      await fn();
    } finally {
      this.busy = false;
      await this.persist({ busy: false });
    }
  }

  private ensureSessionDir() {
    mkdirSync(this.config.sessionDir, { recursive: true, mode: 0o700 });
    chmodSync(this.config.sessionDir, 0o700);
  }

  private async removeSession() {
    rmSync(this.pairedMarker, { force: true });
    await rm(this.profileDir, { recursive: true, force: true });
  }

  /**
   * A hard-killed worker leaves Chromium running and holding the profile lock,
   * which makes the next launch fail. Stop it, but only after confirming the
   * PID in the lock really is a browser using our profile directory.
   */
  private async reapOrphanedBrowser() {
    const lock = path.join(this.profileDir, "SingletonLock");
    let target: string;
    try {
      target = readlinkSync(lock);
    } catch {
      return; // no lock
    }
    const pid = Number(target.split("-").pop());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      let command = "";
      try {
        command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      } catch {
        // process already gone
      }
      if (command.includes(`--user-data-dir=${this.profileDir}`)) {
        logger.warn("whatsapp.orphaned_browser_reaped", { pid });
        try {
          process.kill(pid, "SIGTERM");
          for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
          if (isAlive(pid)) process.kill(pid, "SIGKILL");
        } catch {
          // already exited
        }
      } else if (command) {
        return; // lock held by something else; leave it alone
      }
    }
    for (const file of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      rmSync(path.join(this.profileDir, file), { force: true });
    }
  }

  private async start() {
    this.ensureSessionDir();
    await this.reapOrphanedBrowser();
    this.stopping = false;
    this.qr = null;
    await this.setState("connecting", { lastError: null });

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: this.config.sessionDir }),
      deviceName: this.config.deviceName,
      webVersionCache: { type: "local", path: path.join(path.dirname(this.config.sessionDir), "whatsapp-web-cache") },
      puppeteer: {
        headless: true,
        // The worker owns shutdown; Puppeteer's own handlers would exit the
        // process before the final status write and lease release.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        executablePath: this.config.executablePath,
        args: this.config.noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
      },
    });
    this.client = client;
    this.bindEvents(client);

    // initialize() resolves late (after auth), so it isn't awaited here;
    // progress is tracked through events.
    client.initialize().catch(async (error: unknown) => {
      if (this.client !== client) return;
      await reportError(error, { source: "whatsapp_worker", event: "whatsapp.initialize_failed" });
      await this.teardown();
      await this.setState("disconnected", {
        lastDisconnectedAt: new Date(),
        lastDisconnectReason: "INITIALIZE_FAILED",
        lastError: "WhatsApp Web could not be started. Check the worker logs and Chromium installation.",
      });
      this.scheduleReconnect();
    });
  }

  private bindEvents(client: InstanceType<typeof Client>) {
    const current = () => this.client === client;

    client.on("qr", async (qr: string) => {
      if (!current()) return;
      this.qr = { value: qr, generatedAt: new Date() };
      if (!this.pairingTimer) {
        this.pairingTimer = setTimeout(() => void this.onPairingTimeout(client), PAIRING_TIMEOUT_MS);
      }
      if (this.state !== "qr_required") {
        logger.info("whatsapp.qr_required");
        await this.setState("qr_required");
      }
    });

    client.on("authenticated", async () => {
      if (!current()) return;
      this.qr = null;
      this.clearPairingTimer();
      logger.info("whatsapp.authenticated");
      await this.setState("connecting");
    });

    client.on("auth_failure", async () => {
      if (!current()) return;
      logger.warn("whatsapp.auth_failure");
      this.clearPairingTimer();
      await this.teardown();
      // The saved session is no longer valid; the next connect must re-pair.
      await this.removeSession();
      await this.setState("auth_failed", {
        lastDisconnectedAt: new Date(),
        lastDisconnectReason: "AUTH_FAILURE",
        lastError: "WhatsApp rejected the session. Reconnect and scan a new QR code.",
      });
    });

    client.on("ready", async () => {
      if (!current()) return;
      this.reconnectAttempts = 0;
      this.clearPairingTimer();
      writeFileSync(this.pairedMarker, new Date().toISOString(), { mode: 0o600 });
      const info = client.info;
      logger.info("whatsapp.ready");
      await this.setState("connected", {
        lastReadyAt: new Date(),
        lastError: null,
        accountMaskedNumber: info?.wid?.user ? maskAccountNumber(info.wid.user) : null,
        accountPushName: info?.pushname ? info.pushname.slice(0, 60) : null,
        accountPlatform: info?.platform ? info.platform.slice(0, 30) : null,
      });
    });

    client.on("change_state", async (waState: string) => {
      if (!current()) return;
      logger.info("whatsapp.change_state", { waState });
      if (waState === "TOS_BLOCK" || waState === "SMB_TOS_BLOCK") {
        await this.persist({ lastError: "WhatsApp has restricted this account (terms-of-service block)." });
      }
    });

    client.on("disconnected", async (reason: string) => {
      if (!current()) return;
      logger.warn("whatsapp.disconnected", { reason: String(reason).slice(0, 40) });
      this.clearPairingTimer();
      await this.teardown();
      await this.setState("disconnected", { lastDisconnectedAt: new Date(), lastDisconnectReason: String(reason).slice(0, 60) });
      // LOGOUT means the device was unlinked from the phone: wait for an admin.
      if (reason === "LOGOUT") await this.removeSession();
      else this.scheduleReconnect();
    });

    client.on("message", (message: WAWebJS.Message) => {
      if (!current()) return;
      void this.handleInbound(message).catch((error: unknown) =>
        reportError(error, { source: "whatsapp_worker", event: "whatsapp.inbound_failed" }),
      );
    });

    client.on("message_ack", (message: WAWebJS.Message, ack: number) => {
      const mapped = ACK_MAP[ack];
      if (!current() || !mapped || !message.fromMe) return;
      void this.callbacks.onAck(message.id._serialized, mapped).catch((error: unknown) =>
        logger.error("whatsapp.ack_failed", { errorName: error instanceof Error ? error.name : "UnknownError" }),
      );
    });
  }

  private async handleInbound(message: WAWebJS.Message) {
    if (message.fromMe || message.isStatus || (message.type !== "chat" && message.type !== "location")) return;
    const from = message.from ?? "";
    if (!from.endsWith("@c.us") && !from.endsWith("@lid")) return; // groups, channels, broadcasts

    let digits = from.endsWith("@c.us") ? from.split("@")[0] : "";
    if (!digits) {
      const contact = await message.getContact();
      digits = (contact?.number ?? "").replace(/\D/g, "");
    }
    const e164 = indianE164FromDigits(digits);
    if (!e164) return;
    const providerMessageId = message.id?._serialized;
    if (!providerMessageId) return;

    if (message.type === "location") {
      const latitude = Number(message.location?.latitude);
      const longitude = Number(message.location?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      await this.callbacks.onInbound({ providerMessageId, fromE164: e164, input: { type: "location", latitude, longitude } });
      return;
    }
    await this.callbacks.onInbound({ providerMessageId, fromE164: e164, input: { type: "text", text: (message.body ?? "").slice(0, 300) } });
  }

  private async onPairingTimeout(client: InstanceType<typeof Client>) {
    this.pairingTimer = null;
    if (this.client !== client || this.state !== "qr_required") return;
    logger.info("whatsapp.pairing_timeout");
    await this.teardown();
    if (!existsSync(this.pairedMarker)) await this.removeSession();
    await this.setState("disconnected", {
      lastDisconnectedAt: new Date(),
      lastDisconnectReason: "PAIRING_TIMEOUT",
      lastError: "The QR code wasn't scanned within 5 minutes. Press Connect to try again.",
    });
  }

  private scheduleReconnect() {
    if (this.stopping || this.reconnectTimer || !this.hasSavedSession()) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 5_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    logger.info("whatsapp.reconnect_scheduled", { delayMs: delay, attempt: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect({ restart: true }).catch((error: unknown) =>
        logger.warn("whatsapp.reconnect_failed", { errorName: error instanceof Error ? error.name : "UnknownError" }),
      );
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearPairingTimer() {
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
  }

  /** Destroys the browser if running. Never throws. */
  private async teardown() {
    const client = this.client;
    this.client = null;
    this.qr = null;
    if (client) await destroyClient(client);
  }

  private async setState(state: WhatsAppConnectionState, extra: Parameters<typeof writeConnection>[1] = {}) {
    this.state = state;
    await this.persist({ state, ...extra });
  }

  private async persist(patch: Parameters<typeof writeConnection>[1]) {
    try {
      await writeConnection(this.owner, patch);
    } catch (error) {
      await reportError(error, { source: "whatsapp_worker", event: "whatsapp.persist_failed" });
    }
  }
}
