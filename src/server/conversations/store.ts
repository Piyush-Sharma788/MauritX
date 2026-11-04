import "server-only";
import type { Types } from "mongoose";
import { decryptPii, encryptPii } from "@/lib/security/crypto";
import { ONBOARDING_STATES, type OnboardingState, type Snapshot } from "@/server/conversations/onboarding-machine";
import { WhatsAppConversation, type WhatsAppConversationDoc } from "@/server/models/whatsapp-conversation";

/** Progress is kept this long after the last message, so registration can resume. */
export const CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ConversationRecord = WhatsAppConversationDoc & { _id: Types.ObjectId; updatedAt: Date };

export class ConversationConflictError extends Error {
  constructor() {
    super("Conversation was updated concurrently");
    this.name = "ConversationConflictError";
  }
}

const isState = (s: string): s is OnboardingState => (ONBOARDING_STATES as readonly string[]).includes(s);

export async function loadConversation(phoneLookup: string): Promise<ConversationRecord | null> {
  return (await WhatsAppConversation.findOne({ phoneLookup }).lean()) as ConversationRecord | null;
}

export function toSnapshot(record: ConversationRecord): Snapshot {
  const state = isState(record.state) ? record.state : "name";
  return {
    flow: record.flow,
    state,
    history: record.history.filter(isState),
    data: JSON.parse(decryptPii(record.dataEncrypted)),
  };
}

/** Starts (or restarts) a bot conversation for a number. */
export async function beginConversation(input: {
  phoneLookup: string;
  snapshot: Snapshot;
  userId?: Types.ObjectId;
  now: Date;
}): Promise<void> {
  await WhatsAppConversation.findOneAndUpdate(
    { phoneLookup: input.phoneLookup },
    {
      $set: {
        flow: input.snapshot.flow,
        status: "active",
        state: input.snapshot.state,
        history: input.snapshot.history,
        dataEncrypted: encryptPii(JSON.stringify(input.snapshot.data)),
        startedVia: "whatsapp",
        lastInboundAt: input.now,
        expiresAt: new Date(input.now.getTime() + CONVERSATION_RETENTION_MS),
        ...(input.userId ? { userId: input.userId } : {}),
      },
      $unset: { completedAt: 1, cancelledAt: 1 },
      $inc: { version: 1 },
    },
    { upsert: true },
  );
}

/** Saves progress only if nobody else changed the conversation since it was read. */
export async function saveConversation(
  record: ConversationRecord,
  update: { snapshot?: Snapshot; status: "active" | "completed" | "cancelled"; userId?: Types.ObjectId; now: Date },
): Promise<void> {
  const $set: Record<string, unknown> = {
    status: update.status,
    lastInboundAt: update.now,
    expiresAt: new Date(update.now.getTime() + CONVERSATION_RETENTION_MS),
  };
  if (update.snapshot) {
    $set.state = update.snapshot.state;
    $set.history = update.snapshot.history;
    $set.dataEncrypted = encryptPii(JSON.stringify(update.snapshot.data));
  }
  if (update.status !== "active") {
    // Answers aren't kept once the conversation ends.
    $set.dataEncrypted = encryptPii("{}");
    $set.history = [];
  }
  if (update.status === "completed") $set.completedAt = update.now;
  if (update.status === "cancelled") $set.cancelledAt = update.now;
  if (update.userId) $set.userId = update.userId;

  const result = await WhatsAppConversation.updateOne({ _id: record._id, version: record.version }, { $set, $inc: { version: 1 } });
  if (result.matchedCount !== 1) throw new ConversationConflictError();
}
