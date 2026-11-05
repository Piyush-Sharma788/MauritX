import "server-only";
import type { WhatsAppQrResponse } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";

const unavailable = () =>
  new AppError(503, "WHATSAPP_WORKER_UNAVAILABLE", "The WhatsApp worker isn't running. Start it with `npm run whatsapp:worker`.");

/** Calls the worker's loopback control channel. Used by admin route handlers (and development sign-in codes). */
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

export type WorkerOtpResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; reason: "not_connected" | "not_on_whatsapp" | "unavailable" | "failed" };

/**
 * Development only: asks the WhatsApp worker to send a sign-in code from the linked phone.
 * Returns why it couldn't, instead of throwing, so the caller can choose a fallback.
 */
async function sendOtp(input: { phone: string; code: string; minutes: number }): Promise<WorkerOtpResult> {
  const config = getWhatsAppWebConfig();
  let response: Response;
  try {
    response = await fetch(new URL("/send-otp", config.workerUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.workerSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { providerMessageId?: unknown } | null;
    return typeof body?.providerMessageId === "string" ? { ok: true, providerMessageId: body.providerMessageId } : { ok: false, reason: "failed" };
  }
  if (response.status === 503) return { ok: false, reason: "not_connected" };
  if (response.status === 422) return { ok: false, reason: "not_on_whatsapp" };
  return { ok: false, reason: response.status === 401 || response.status === 404 ? "unavailable" : "failed" };
}

export const whatsappWorker = {
  sendOtp,
  getQr: () => call<WhatsAppQrResponse>("GET", "/qr"),
  connect: (restart: boolean) => call<{ state: string }>("POST", "/connect", { restart }, 30_000),
  logout: () => call<{ state: string }>("POST", "/logout", undefined, 45_000),
};
