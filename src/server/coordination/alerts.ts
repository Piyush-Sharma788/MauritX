import "server-only";
import { Types } from "mongoose";
import { ALERTABLE_STATUSES } from "@/features/coordination/schemas";
import type { AlertBatchResult } from "@/features/coordination/types";
import { AppError } from "@/lib/api/errors";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { encryptPii } from "@/lib/security/crypto";
import { loadRun, RETRYABLE_FAILURES } from "@/server/matching/service";
import { queueEmergencyRequestNotification } from "@/server/messaging/queue";
import { emergencyRequestText, type EmergencyRequestSummary } from "@/server/messaging/templates";
import { EmergencyRequest, type EmergencyRequestDoc } from "@/server/models/emergency-request";
import { NotificationEvent } from "@/server/models/notification-event";
import { recordAudit } from "@/server/services/audit";
import { getMessagingSettings } from "@/server/settings/service";

/**
 * Emergency alert orchestration. Alerts are never automatic: an admin runs a
 * donor search for a verified, active request, then sends small batches in
 * rank order. Consent, opt-out, availability, the request's state and each
 * donor's daily cap are checked when an alert is queued and again just
 * before it is sent.
 */

export function alertSummary(request: Pick<EmergencyRequestDoc, "publicRequestId" | "hospitalName" | "locality" | "city" | "bloodGroup" | "component" | "unitsRequested" | "requiredBy">): EmergencyRequestSummary {
  return {
    publicRequestId: request.publicRequestId,
    hospitalName: request.hospitalName,
    locality: request.locality,
    city: request.city,
    bloodGroup: request.bloodGroup,
    component: request.component,
    unitsRequested: request.unitsRequested,
    neededBy: request.requiredBy,
  };
}

const isAlertable = (status: string) => (ALERTABLE_STATUSES as readonly string[]).includes(status);

export async function sendAlertBatch(publicRequestId: string, matchingRunId: string, adminUserId: Types.ObjectId, requestId: string, now = new Date()): Promise<AlertBatchResult> {
  await connectToDatabase();
  const request = await EmergencyRequest.findOne({ publicRequestId }).lean();
  if (!request) throw new AppError(404, "NOT_FOUND", "We couldn't find that request.");
  if (!isAlertable(request.status) || request.expiresAt <= now) {
    throw new AppError(409, "INVALID_TRANSITION", "Alerts can only be sent for verified requests that are active.");
  }
  if ((await getMessagingSettings()).alertsPaused) {
    throw new AppError(409, "ALERTS_PAUSED", "Emergency alerts are paused. Resume them on the Operations page first.");
  }
  const run = await loadRun(matchingRunId, request._id);
  if (!run) throw new AppError(409, "MATCHING_REQUIRED", "Run a donor search for this request first.");

  const config = getCoordinationConfig();
  const requestKey = request._id.toString();
  const alreadyAlerted = await NotificationEvent.find({ requestId: requestKey, kind: "emergency_request" }, { recipientUserId: 1, status: 1 }).lean();
  const sentOrQueued = alreadyAlerted.filter((a) => a.status !== "suppressed").length;
  const remainingAllowance = config.alertMaxPerRequest - sentOrQueued;
  if (remainingAllowance <= 0) {
    throw new AppError(409, "ALERT_LIMIT_REACHED", `This request has reached the limit of ${config.alertMaxPerRequest} alerts.`);
  }

  const contacted = new Set(alreadyAlerted.map((a) => a.recipientUserId?.toString()));
  const pending = run.candidates.filter((c) => !contacted.has(c.donorUserId.toString())).sort((a, b) => a.rank - b.rank);
  const batch = pending.slice(0, Math.min(config.alertBatchSize, remainingAllowance));

  const result: AlertBatchResult = { queued: 0, suppressed: 0, duplicates: 0, remainingCandidates: pending.length - batch.length };
  const summary = alertSummary(request);
  for (const candidate of batch) {
    const outcome = await queueEmergencyRequestNotification({
      requestId: requestKey,
      donorUserId: candidate.donorUserId,
      summary,
      matchingRunId: run._id,
      ttlMs: config.alertTtlMs,
    });
    if (outcome.outcome === "queued") result.queued += 1;
    else if (outcome.outcome === "duplicate") result.duplicates += 1;
    else result.suppressed += 1;
  }

  if (result.queued > 0) {
    await EmergencyRequest.updateOne({ _id: request._id }, { $inc: { "responseStats.alertsQueued": result.queued } });
  }
  await recordAudit({
    action: "alerts.batch_queued",
    outcome: "success",
    requestId,
    actorUserId: adminUserId,
    resourceType: "emergency_request",
    resourceId: `${publicRequestId}:queued=${result.queued}:suppressed=${result.suppressed}`,
  });
  return result;
}

/** A closed request must not reach anyone else: withdraw its queued alerts at once. */
export async function withdrawQueuedAlerts(requestObjectId: Types.ObjectId | string, now = new Date()): Promise<number> {
  const result = await NotificationEvent.updateMany(
    { requestId: requestObjectId.toString(), kind: "emergency_request", status: "queued" },
    { $set: { status: "suppressed", failureCode: "REQUEST_CLOSED", failedAt: now }, $unset: { bodyEncrypted: 1 } },
  );
  return result.modifiedCount;
}

/** Codes where the message certainly wasn't delivered, so sending it again can't create a duplicate. */
export { RETRYABLE_FAILURES };

/**
 * Puts an alert that certainly wasn't delivered back in the queue, with text
 * rebuilt from the current request. Used by admin retries and by donor waves
 * (so a WhatsApp outage that let alerts expire doesn't leave donors skipped).
 * The dispatcher still re-checks consent and the request before sending.
 */
export async function requeueUndeliveredAlert(
  messageId: Types.ObjectId,
  request: Parameters<typeof alertSummary>[0],
  distanceKm: number | null,
  now = new Date(),
): Promise<boolean> {
  const updated = await NotificationEvent.updateOne(
    { _id: messageId, kind: "emergency_request", status: "failed", failureCode: { $in: [...RETRYABLE_FAILURES] } },
    {
      $set: {
        status: "queued",
        bodyEncrypted: encryptPii(emergencyRequestText({ ...alertSummary(request), distanceKm })),
        attempts: 0,
        nextAttemptAt: now,
        expiresAt: new Date(now.getTime() + getCoordinationConfig().alertTtlMs),
      },
      $unset: { failureCode: 1, failedAt: 1, lockedUntil: 1 },
    },
  );
  return updated.modifiedCount === 1;
}

/** Re-queues one failed emergency alert, rebuilt from the current request, if it is still safe and useful. */
export async function retryFailedAlert(messageId: string, adminUserId: Types.ObjectId, requestId: string, now = new Date()): Promise<{ status: "queued" }> {
  await connectToDatabase();
  if (!Types.ObjectId.isValid(messageId)) throw new AppError(404, "NOT_FOUND", "Message not found.");
  const message = await NotificationEvent.findById(messageId).lean();
  if (!message) throw new AppError(404, "NOT_FOUND", "Message not found.");
  if (message.kind !== "emergency_request" || message.status !== "failed" || !RETRYABLE_FAILURES.has(message.failureCode ?? "")) {
    throw new AppError(409, "NOT_RETRYABLE", "Only emergency alerts that certainly weren't delivered can be retried.");
  }
  if ((await getMessagingSettings()).alertsPaused) {
    throw new AppError(409, "ALERTS_PAUSED", "Emergency alerts are paused. Resume them first.");
  }
  const request = message.requestId && Types.ObjectId.isValid(message.requestId) ? await EmergencyRequest.findById(message.requestId).lean() : null;
  if (!request || !isAlertable(request.status) || request.expiresAt <= now) {
    throw new AppError(409, "NOT_RETRYABLE", "The request is no longer active, so this alert won't be resent.");
  }

  if (!(await requeueUndeliveredAlert(message._id, request, null, now))) throw new AppError(409, "CONFLICT", "This message changed just now. Refresh and try again.");
  await recordAudit({ action: "alerts.message_retried", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "notification_event", resourceId: messageId });
  return { status: "queued" };
}
