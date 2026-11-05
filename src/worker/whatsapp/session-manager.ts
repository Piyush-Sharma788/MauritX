import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import WAWebJS from "whatsapp-web.js";
import type { WhatsAppConnectionState } from "@/features/whatsapp/types";
import { logger } from "@/lib/logger";
import { reportError } from "@/server/monitoring/report";
import { maskPhone } from "@/lib/validation/phone";
import type { WhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { MAX_INBOUND_TEXT, type InboundEvent } from "@/server/messaging/inbound";
import { MessagingError, type DeliveryAck, type MessagingProvider, type OutboundImage } from "@/server/messaging/provider";
import { writeConnection } from "@/server/whatsapp/connection-store";
import { serializeMessageId, serializeWid } from "@/worker/whatsapp/wa-ids";

const { Client, LocalAuth, MessageMedia } = WAWebJS;

const CLIENT_ID = "marutix";
const PAIRING_TIMEOUT_MS = 5 * 60_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 30_000;
const MEDIA_SEND_TIMEOUT_MS = 60_000;

/** Message types people send that the bot can't read: they get a one-line explanation. */
const UNSUPPORTED_TYPES = new Set(["image", "video", "audio", "ptt", "ptv", "document", "sticker", "vcard", "multi_vcard", "poll_creation", "product", "order"]);
/** Media types whose caption is read as text, if there is one. */
const CAPTIONED_TYPES = new Set(["image", "video", "document"]);

export class BusyError extends Error {
  constructor() {
    super("A WhatsApp connection change is already in progress");
    this.name = "BusyError";
  }
}

export interface SessionCallbacks {
  onInbound(message: InboundEvent): Promise<void>;
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

/** A short, number-free description of a library error for the logs. */
function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\d{6,}/g, "<n>").slice(0, 160);
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

  /** The chat for a number. Nothing has been sent yet when this fails. */
  private async chatIdFor(client: InstanceType<typeof Client>, phoneE164: string): Promise<string> {
    let numberId;
    try {
      numberId = await withTimeout(client.getNumberId(phoneE164.replace(/^\+/, "")), LOOKUP_TIMEOUT_MS, () => new MessagingError("SEND_TIMEOUT", true));
    } catch (error) {
      throw error instanceof MessagingError ? error : new MessagingError("SEND_FAILED", true);
    }
    const chatId = serializeWid(numberId);
    if (!chatId) throw new MessagingError("NOT_ON_WHATSAPP", false, true);
    return chatId;
  }

  /**
   * From here on the message may already be on its way: nothing is retried automatically,
   * because a duplicate emergency alert is worse than one an admin re-sends by hand.
   */
  private async sendStarted(send: () => Promise<WAWebJS.Message>, timeoutMs: number): Promise<{ providerMessageId: string }> {
    let message: WAWebJS.Message | undefined;
    try {
      message = await withTimeout(send(), timeoutMs, () => new MessagingError("SEND_TIMEOUT", false, false));
    } catch (error) {
      if (error instanceof MessagingError) throw error;
      logger.warn("whatsapp.send_error", { errorName: error instanceof Error ? error.name : "UnknownError", detail: errorDetail(error) });
      throw new MessagingError("SEND_FAILED", false, false);
    }
    const providerMessageId = serializeMessageId(message?.id);
    if (providerMessageId) return { providerMessageId };
    // WhatsApp accepted the send but returned no readable ID: record it as sent (it most
    // likely was) rather than send it again. Delivery receipts can't be matched to it.
    logger.warn("whatsapp.send_without_id", { returned: message ? "message_without_id" : "nothing" });
    return { providerMessageId: `unknown:${randomUUID()}` };
  }

  async sendText(phoneE164: string, body: string): Promise<{ providerMessageId: string }> {
    const client = this.client;
    if (!client || !this.isReady()) throw new MessagingError("NOT_CONNECTED", true);
    const chatId = await this.chatIdFor(client, phoneE164);
    return this.sendStarted(() => client.sendMessage(chatId, body), SEND_TIMEOUT_MS);
  }

  /** Image files read once per worker (they're small and fixed). */
  private readonly mediaCache = new Map<string, InstanceType<typeof MessageMedia>>();

  async sendImage(phoneE164: string, image: OutboundImage, caption: string): Promise<{ providerMessageId: string }> {
    const client = this.client;
    if (!client || !this.isReady()) throw new MessagingError("NOT_CONNECTED", true);
    let media = this.mediaCache.get(image.filePath);
    if (!media) {
      try {
        media = MessageMedia.fromFilePath(image.filePath);
        this.mediaCache.set(image.filePath, media);
      } catch (error) {
        logger.warn("whatsapp.media_unreadable", { key: image.key, errorName: error instanceof Error ? error.name : "UnknownError" });
        throw new MessagingError("MEDIA_UNAVAILABLE", false, true);
      }
    }
    const chatId = await this.chatIdFor(client, phoneE164);
    const prepared = media;
    return this.sendStarted(() => client.sendMessage(chatId, prepared, { caption }), MEDIA_SEND_TIMEOUT_MS);
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

  /**
   * After an unclean exit (crash, force-kill, power loss) Chromium restores its previous
   * tabs on the next launch. Restored WhatsApp Web tabs then compete with the new one for
   * the same session ("WhatsApp is open in another window") and the client never becomes
   * ready. Forget the saved tabs; the login itself lives in IndexedDB/Local Storage.
   */
  private forgetRestoredTabs() {
    rmSync(path.join(this.profileDir, "Default", "Sessions"), { recursive: true, force: true });
  }

  private async start() {
    this.ensureSessionDir();
    await this.reapOrphanedBrowser();
    this.forgetRestoredTabs();
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
        args: this.config.noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : [],
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
      QRCode.toString(qr, { type: "terminal", small: true })
        .then((art) => {
          console.log("\nScan this QR code with WhatsApp on your pilot phone:\n" + art);
        })
        .catch(() => {});
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
      const id = serializeMessageId(message.id);
      if (!id) return;
      void this.callbacks.onAck(id, mapped).catch((error: unknown) =>
        logger.error("whatsapp.ack_failed", { errorName: error instanceof Error ? error.name : "UnknownError" }),
      );
    });
  }

  /**
   * The sender's phone number. WhatsApp increasingly identifies people by a private
   * "linked ID" (…@lid) instead of their number; ask WhatsApp to map it back.
   */
  private async senderDigits(client: InstanceType<typeof Client>, from: string, message: WAWebJS.Message): Promise<string> {
    if (from.endsWith("@c.us")) return from.split("@")[0];
    try {
      const [mapped] = await withTimeout(client.getContactLidAndPhone([from]), LOOKUP_TIMEOUT_MS, () => new Error("lid lookup timeout"));
      const pn = mapped?.pn ?? "";
      if (pn.endsWith("@c.us")) return pn.split("@")[0];
    } catch (error) {
      logger.warn("whatsapp.lid_lookup_failed", { errorName: error instanceof Error ? error.name : "UnknownError", detail: errorDetail(error) });
    }
    try {
      const contact = await message.getContact();
      return (contact?.number ?? "").replace(/\D/g, "");
    } catch {
      return "";
    }
  }

  private async handleInbound(message: WAWebJS.Message) {
    // Our own messages and status updates aren't messages to the bot.
    if (message.fromMe || message.isStatus) return;
    const from = typeof message.from === "string" ? message.from : (serializeWid(message.from) ?? "");
    // Every drop below is logged (without the number), so a message never disappears silently.
    const dropped = (reason: string, extra: Record<string, string> = {}) => logger.info("whatsapp.inbound_dropped", { reason, type: String(message.type).slice(0, 30), ...extra });
    if (!from.endsWith("@c.us") && !from.endsWith("@lid")) return dropped(from.endsWith("@g.us") ? "group_chat" : "not_a_person"); // groups, channels, broadcasts
    const client = this.client;
    if (!client) return dropped("client_stopped");

    const type = String(message.type);
    const caption = CAPTIONED_TYPES.has(type) ? (message.body ?? "").trim() : "";
    if (type !== "chat" && type !== "location" && !UNSUPPORTED_TYPES.has(type)) return dropped("system_message_type");

    const providerMessageId = serializeMessageId(message.id);
    if (!providerMessageId) return dropped("unreadable_message_id", { sender: from.endsWith("@lid") ? "lid" : "phone" });
    const digits = await this.senderDigits(client, from, message);
    const e164 = indianE164FromDigits(digits);
    if (!e164) return dropped(digits ? "not_an_indian_mobile" : "sender_number_unknown", { sender: from.endsWith("@lid") ? "lid" : "phone" });

    if (type === "location") {
      const latitude = Number(message.location?.latitude);
      const longitude = Number(message.location?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return dropped("invalid_location");
      await this.callbacks.onInbound({ providerMessageId, fromE164: e164, input: { type: "location", latitude, longitude } });
      return;
    }
    if (UNSUPPORTED_TYPES.has(type) && !caption) {
      await this.callbacks.onInbound({ providerMessageId, fromE164: e164, input: { type: "unsupported", mediaType: type } });
      return;
    }
    // A photo with a caption: the caption is what we can read.
    const text = type === "chat" ? (message.body ?? "") : caption;
    if (text.length > MAX_INBOUND_TEXT) logger.info("whatsapp.inbound_truncated", { length: text.length });
    await this.callbacks.onInbound({ providerMessageId, fromE164: e164, input: { type: "text", text: text.slice(0, MAX_INBOUND_TEXT) } });
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
