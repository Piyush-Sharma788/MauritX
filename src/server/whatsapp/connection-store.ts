import "server-only";
import type { WhatsAppStatusResponse } from "@/features/whatsapp/types";
import { connectToDatabase } from "@/lib/db/mongoose";
import type { WhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { WhatsAppConnection, type WhatsAppConnectionDoc } from "@/server/models/whatsapp-connection";

const CONNECTION_ID = "primary";
export const LEASE_TTL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_MS = 30_000;

type ConnectionPatch = Partial<
  Pick<
    WhatsAppConnectionDoc,
    | "state"
    | "busy"
    | "accountMaskedNumber"
    | "accountPushName"
    | "accountPlatform"
    | "lastReadyAt"
    | "lastDisconnectedAt"
    | "lastDisconnectReason"
    | "lastError"
  >
>;

const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * Claims the single WhatsApp session lease. Returns false if another live
 * worker holds it, so two clients can never drive the same account.
 */
export async function acquireLease(owner: string, now = new Date()): Promise<boolean> {
  await connectToDatabase();
  try {
    const doc = await WhatsAppConnection.findOneAndUpdate(
      { _id: CONNECTION_ID, $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }, { leaseOwner: owner }] },
      {
        $set: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS), heartbeatAt: now },
        $setOnInsert: { state: "disconnected", busy: false },
      },
      { upsert: true, returnDocument: "after", lean: true },
    );
    return doc?.leaseOwner === owner;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

/** Extends the lease and records a heartbeat. False means the lease was lost. */
export async function renewLease(owner: string, now = new Date()): Promise<boolean> {
  const result = await WhatsAppConnection.updateOne(
    { _id: CONNECTION_ID, leaseOwner: owner },
    { $set: { leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS), heartbeatAt: now } },
  );
  return result.matchedCount === 1;
}

export async function releaseLease(owner: string): Promise<void> {
  await WhatsAppConnection.updateOne(
    { _id: CONNECTION_ID, leaseOwner: owner },
    { $set: { leaseOwner: null, heartbeatAt: null, busy: false } },
  );
}

/** Writes are fenced on the lease so a stale worker can't overwrite state. */
export async function writeConnection(owner: string, patch: ConnectionPatch): Promise<void> {
  await WhatsAppConnection.updateOne({ _id: CONNECTION_ID, leaseOwner: owner }, { $set: patch });
}

const iso = (d?: Date | null) => (d ? d.toISOString() : null);

export async function readConnectionStatus(config: WhatsAppWebConfig, now = new Date()): Promise<WhatsAppStatusResponse> {
  await connectToDatabase();
  const doc = await WhatsAppConnection.findById(CONNECTION_ID).lean();
  const workerOnline = Boolean(doc?.heartbeatAt && now.getTime() - doc.heartbeatAt.getTime() < HEARTBEAT_STALE_MS);
  return {
    provider: "whatsapp_web",
    state: workerOnline && doc ? doc.state : "disconnected",
    workerOnline,
    busy: workerOnline && Boolean(doc?.busy),
    account: doc?.accountMaskedNumber
      ? { maskedNumber: doc.accountMaskedNumber, pushName: doc.accountPushName ?? null, platform: doc.accountPlatform ?? null }
      : null,
    lastReadyAt: iso(doc?.lastReadyAt),
    lastDisconnectedAt: iso(doc?.lastDisconnectedAt),
    lastDisconnectReason: doc?.lastDisconnectReason ?? null,
    lastError: doc?.lastError ?? null,
    updatedAt: iso((doc as { updatedAt?: Date } | null)?.updatedAt),
    limits: { maxMessagesPerHour: config.maxMessagesPerHour, minSendIntervalMs: config.minSendIntervalMs },
  };
}
