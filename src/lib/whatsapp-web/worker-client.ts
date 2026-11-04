import "server-only";
import type { WhatsAppQrResponse } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";

const unavailable = () =>
  new AppError(503, "WHATSAPP_WORKER_UNAVAILABLE", "The WhatsApp worker isn't running. Start it with `npm run whatsapp:worker`.");

/** Calls the worker's loopback control channel. Used only by admin route handlers. */
async function call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 8_000): Promise<T> {
  const config = getWhatsAppWebConfig();
  let response: Response;
  try {
    response = await fetch(new URL(path, config.workerUrl), {
      method,
      headers: { Authorization: `Bearer ${config.workerSecret}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw unavailable();
  }

  if (response.ok) return (await response.json()) as T;
  if (response.status === 404 && path === "/qr") {
    throw new AppError(404, "WHATSAPP_QR_NOT_AVAILABLE", "No QR code is available right now.");
  }
  if (response.status === 409) {
    throw new AppError(409, "CONFLICT", "A connection change is already in progress. Try again in a moment.");
  }
  throw unavailable();
}

export const whatsappWorker = {
  getQr: () => call<WhatsAppQrResponse>("GET", "/qr"),
  connect: (restart: boolean) => call<{ state: string }>("POST", "/connect", { restart }, 30_000),
  logout: () => call<{ state: string }>("POST", "/logout", undefined, 45_000),
};
