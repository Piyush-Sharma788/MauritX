import "server-only";
import type { Types } from "mongoose";
import { logger } from "@/lib/logger";
import { AuditLog, type AuditAction } from "@/server/models/audit-log";

interface AuditEvent {
  action: AuditAction;
  outcome: "success" | "failure";
  requestId: string;
  actorUserId?: Types.ObjectId | string;
  resourceType?: string;
  resourceId?: string;
}

/** Best-effort append. An audit write failure is logged but never breaks the user flow. */
export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    await AuditLog.create(event);
  } catch (error) {
    logger.error("audit.write_failed", {
      requestId: event.requestId,
      action: event.action,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
