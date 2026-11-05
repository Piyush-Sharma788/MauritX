import "server-only";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { redactText } from "@/lib/security/redact";
import { ErrorEvent, type ErrorSource } from "@/server/models/error-event";

const ALERT_EVERY_MS = 30 * 60_000;
const ALERT_TIMEOUT_MS = 5_000;

export interface ErrorContext {
  source: ErrorSource;
  /** Stable event name, e.g. "api.unhandled_error". */
  event: string;
  /** Route file path or job type. Never a URL with its parameters. */
  where?: string;
  requestId?: string;
}

const describe = (error: unknown) => ({
  errorName: error instanceof Error ? error.name : typeof error === "string" ? "Error" : "UnknownError",
  message: redactText(error instanceof Error ? error.message : typeof error === "string" ? error : "", 600),
});

/** Same kind of error, same row: numbers and IDs in the message don't split it. */
export function errorFingerprint(context: Pick<ErrorContext, "source" | "event" | "where">, errorName: string, message: string): string {
  const shape = message.replace(/[0-9a-f]{24}/gi, "<id>").replace(/\d+/g, "<n>").slice(0, 200);
  return createHash("sha256").update([context.source, context.event, context.where ?? "", errorName, shape].join("|")).digest("hex").slice(0, 20);
}

/**
 * Records an unexpected error: one redacted structured log line, a counted
 * row in `error_events` (for the Operations page), and an optional alert to
 * ERROR_ALERT_WEBHOOK_URL at most every 30 minutes per kind of error.
 * Never throws and never blocks the caller for long.
 */
export async function reportError(error: unknown, context: ErrorContext, now = new Date()): Promise<void> {
  const { errorName, message } = describe(error);
  const fingerprint = errorFingerprint(context, errorName, message);
  logger.error(context.event, { source: context.source, errorName, errorMessage: message, where: context.where, requestId: context.requestId, fingerprint });

  // Without a live connection (the error may be the database itself), the log line is the record.
  if (mongoose.connection.readyState !== 1) return;
  try {
    const row = await ErrorEvent.findOneAndUpdate(
      { fingerprint },
      {
        $setOnInsert: { fingerprint, source: context.source, event: context.event, errorName, where: context.where, firstSeenAt: now },
        $set: { message, lastSeenAt: now, ...(context.requestId ? { lastRequestId: context.requestId } : {}) },
        $inc: { count: 1 },
      },
      { upsert: true, returnDocument: "after", projection: { count: 1 } },
    ).lean();
    await maybeAlert(fingerprint, { ...context, errorName, message, count: row?.count ?? 1 }, now);
  } catch (storeError) {
    logger.warn("monitoring.store_failed", { errorName: storeError instanceof Error ? storeError.name : "UnknownError" });
  }
}

async function maybeAlert(fingerprint: string, detail: ErrorContext & { errorName: string; message: string; count: number }, now: Date) {
  const url = process.env.ERROR_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  // Claim the alert slot atomically so several processes don't all send it.
  const claimed = await ErrorEvent.updateOne(
    { fingerprint, $or: [{ alertedAt: null }, { alertedAt: { $lte: new Date(now.getTime() - ALERT_EVERY_MS) } }] },
    { $set: { alertedAt: now } },
  );
  if (claimed.modifiedCount === 0) return;
  const text = `MarutiX error (${detail.source}) ${detail.event}: ${detail.errorName}${detail.message ? ` - ${detail.message}` : ""}${detail.where ? ` [${detail.where}]` : ""} · seen ${detail.count}×`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source: detail.source, event: detail.event, fingerprint, count: detail.count }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) logger.warn("monitoring.alert_failed", { status: response.status });
  } catch (alertError) {
    logger.warn("monitoring.alert_failed", { errorName: alertError instanceof Error ? alertError.name : "UnknownError" });
  }
}

export interface ErrorSummary {
  fingerprint: string;
  source: string;
  event: string;
  errorName: string;
  message: string | null;
  where: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export async function listRecentErrors(limit = 20): Promise<ErrorSummary[]> {
  await connectToDatabase();
  const rows = await ErrorEvent.find({}, { alertedAt: 0, lastRequestId: 0 }).sort({ lastSeenAt: -1 }).limit(limit).lean();
  return rows.map((r) => ({
    fingerprint: r.fingerprint,
    source: r.source,
    event: r.event,
    errorName: r.errorName,
    message: r.message ?? null,
    where: r.where ?? null,
    count: r.count,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));
}
