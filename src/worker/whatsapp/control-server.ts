import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { logger } from "@/lib/logger";
import { reportError } from "@/server/monitoring/report";
import { safeEqual } from "@/lib/security/crypto";
import type { WhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { MessagingError } from "@/server/messaging/provider";
import { BusyError, type WhatsAppSessionManager } from "@/worker/whatsapp/session-manager";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_BODY_BYTES = 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error("Body too large");
  }
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/**
 * Private control channel between the Next.js admin API and the worker.
 * Loopback-only and authenticated with WHATSAPP_WEB_WORKER_SECRET. The QR
 * code never leaves this process except through this channel.
 */
export function startControlServer(config: WhatsAppWebConfig, manager: WhatsAppSessionManager): Promise<Server> {
  const { hostname, port } = config.workerUrl;
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("WHATSAPP_WEB_WORKER_URL must use a loopback host (127.0.0.1, localhost or ::1)");
  }

  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    if (!safeEqual(auth, `Bearer ${config.workerSecret}`)) return send(res, 401, { error: "unauthorized" });

    const route = `${req.method} ${new URL(req.url ?? "/", "http://worker").pathname}`;
    try {
      switch (route) {
        case "GET /health":
          return send(res, 200, { state: manager.connectionState });
        case "GET /qr": {
          const qr = manager.currentQr();
          if (!qr) return send(res, 404, { error: "qr_not_available" });
          const svg = await QRCode.toString(qr.value, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
          return send(res, 200, { svg, generatedAt: qr.generatedAt.toISOString() });
        }
        case "POST /connect": {
          const body = await readJson(req);
          await manager.connect({ restart: body.restart === true });
          return send(res, 202, { state: manager.connectionState });
        }
        case "POST /send-otp": {
          // Development only (OTP_PROVIDER=whatsapp_web; the web app refuses it in production).
          // The code is never logged.
          const body = await readJson(req);
          const phone = typeof body.phone === "string" ? body.phone : "";
          const code = typeof body.code === "string" ? body.code : "";
          const minutes = Number(body.minutes);
          if (!/^\+91[6-9]\d{9}$/.test(phone) || !/^\d{4,8}$/.test(code) || !Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
            return send(res, 400, { error: "invalid" });
          }
          if (!manager.isReady()) return send(res, 503, { error: "not_connected" });
          try {
            const text = `${code} is your MarutiX sign-in code. It expires in ${minutes} minutes.\nDon't share it with anyone: MarutiX will never ask you for it.`;
            const sent = await manager.sendText(phone, text);
            return send(res, 200, { providerMessageId: sent.providerMessageId });
          } catch (error) {
            if (error instanceof MessagingError && error.code === "NOT_CONNECTED") return send(res, 503, { error: "not_connected" });
            if (error instanceof MessagingError && error.code === "NOT_ON_WHATSAPP") return send(res, 422, { error: "not_on_whatsapp" });
            return send(res, 502, { error: "send_failed" });
          }
        }
        case "POST /logout":
          await manager.logout();
          return send(res, 200, { state: manager.connectionState });
        default:
          return send(res, 404, { error: "not_found" });
      }
    } catch (error) {
      if (error instanceof BusyError) return send(res, 409, { error: "busy" });
      await reportError(error, { source: "whatsapp_worker", event: "whatsapp.control_error", where: route });
      return send(res, 500, { error: "internal" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port || 80), hostname.replace(/^\[|\]$/g, ""), () => {
      logger.info("whatsapp.control_listening", { host: hostname, port: Number(port) });
      resolve(server);
    });
  });
}
