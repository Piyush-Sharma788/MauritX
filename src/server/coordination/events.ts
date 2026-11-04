import "server-only";
import type { Types } from "mongoose";
import { logger } from "@/lib/logger";
import { CoordinationEvent, type CoordinationEventType } from "@/server/models/coordination-event";

/** Appends to a request's coordination history. Best-effort: never breaks the workflow. */
export async function recordEvent(
  requestId: Types.ObjectId | string,
  type: CoordinationEventType,
  summary: string,
  options: { visibleToRequester?: boolean; actor?: "system" | "admin" | "donor" | "institution" | "requester"; actorUserId?: Types.ObjectId; at?: Date } = {},
): Promise<void> {
  try {
    await CoordinationEvent.create({
      requestId,
      type,
      summary: summary.slice(0, 300),
      visibleToRequester: options.visibleToRequester ?? false,
      actor: options.actor ?? "system",
      actorUserId: options.actorUserId,
      at: options.at ?? new Date(),
    });
  } catch (error) {
    logger.warn("coordination.event_write_failed", { type, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

export async function listEvents(requestId: Types.ObjectId, options: { requesterOnly?: boolean; limit?: number } = {}) {
  const docs = await CoordinationEvent.find({ requestId, ...(options.requesterOnly ? { visibleToRequester: true } : {}) })
    .sort({ at: -1 })
    .limit(options.limit ?? 50)
    .lean();
  return docs.map((d) => ({ type: d.type, summary: d.summary, actor: d.actor, at: d.at.toISOString() }));
}
