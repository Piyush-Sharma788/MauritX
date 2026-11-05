import "server-only";
import { isValidObjectId } from "mongoose";
import type { MessageLogResponse } from "@/features/whatsapp/types";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { NotificationEvent } from "@/server/models/notification-event";

const iso = (d?: Date | null) => (d ? d.toISOString() : null);

/** Newest-first message log for admins. Recipients are masked; bodies are never returned. */
export async function listRecentMessages({ limit, cursor }: { limit: number; cursor?: string }): Promise<MessageLogResponse> {
  await connectToDatabase();
  const filter = cursor && isValidObjectId(cursor) ? { _id: { $lt: cursor } } : {};
  const docs = await NotificationEvent.find(filter, { bodyEncrypted: 0 })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();

  const page = docs.slice(0, limit);
  return {
    messages: page.map((doc) => ({
      id: doc._id.toString(),
      kind: doc.kind,
      recipient: doc.recipientPhoneEncrypted ? maskPhone(decryptPii(doc.recipientPhoneEncrypted)) : "Erased",
      status: doc.status,
      failureCode: doc.failureCode ?? null,
      attempts: doc.attempts,
      createdAt: (doc as { createdAt: Date }).createdAt.toISOString(),
      sentAt: iso(doc.sentAt),
      deliveredAt: iso(doc.deliveredAt),
      readAt: iso(doc.readAt),
      failedAt: iso(doc.failedAt),
    })),
    nextCursor: docs.length > limit ? page[page.length - 1]._id.toString() : null,
  };
}
