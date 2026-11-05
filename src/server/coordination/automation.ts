import "server-only";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { ALERTABLE_STATUSES } from "@/features/coordination/schemas";
import { AppError } from "@/lib/api/errors";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { alertSummary, requeueUndeliveredAlert, withdrawQueuedAlerts } from "@/server/coordination/alerts";
import { recordEvent } from "@/server/coordination/events";
import { interestTarget, planWave, zoneLabel } from "@/server/coordination/zones";
import { cancelJobsFor, enqueueJob } from "@/server/jobs/queue";
import { executeMatching } from "@/server/matching/service";
import { queueEmergencyRequestNotification } from "@/server/messaging/queue";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { InstitutionOutreach } from "@/server/models/institution-outreach";
import { NotificationEvent } from "@/server/models/notification-event";
import { recordAudit } from "@/server/services/audit";
import { getMessagingSettings } from "@/server/settings/service";

/**
 * Automated coordination for one request, started when an admin activates
 * it (COORDINATION_AUTOSTART). Two processes run as background jobs:
 *   A. institution discovery, then outreach;
 *   B. zone-wise donor waves, closest zone first, expanding only while too
 *      few donors are interested.
 * Admins can pause, resume, cancel or run a wave now. Every send still goes
 * through the consent-checked outbox; nothing here bypasses it.
 */

const isAlertable = (s: string) => (ALERTABLE_STATUSES as readonly string[]).includes(s);

/** Called after an admin activates a request. Idempotent per request. */
export async function onRequestActivated(requestObjectId: Types.ObjectId) {
  if (!getCoordinationConfig().autostart) return;
  await enqueueJob("coordinate_request", `coordinate:${requestObjectId.toString()}`, { requestId: requestObjectId.toString() });
}

/** Called when a request closes (fulfilled, cancelled, expired). Stops everything still pending. */
export async function onRequestClosed(requestObjectId: Types.ObjectId, now = new Date()) {
  await EmergencyRequest.updateOne({ _id: requestObjectId, "automation.status": { $in: ["running", "paused"] } }, { $set: { "automation.status": "completed", "automation.changedAt": now, "automation.donorPhase": "stopped" }, $unset: { "automation.nextWaveAt": 1 } });
  await cancelJobsFor(requestObjectId.toString(), ["donor_wave", "institution_outreach", "send_outreach_email", "discover_institutions"]);
  await InstitutionOutreach.updateMany({ requestId: requestObjectId, status: { $in: ["queued", "awaiting_review", "no_contact", "channel_unavailable"] } }, { $set: { status: "cancelled" } });
}

/** Job: start both processes. */
export async function startCoordination(requestObjectId: string, now = new Date()) {
  await connectToDatabase();
  const started = await EmergencyRequest.findOneAndUpdate(
    { _id: requestObjectId, status: { $in: ALERTABLE_STATUSES }, "automation.status": "not_started" },
    { $set: { "automation.status": "running", "automation.startedAt": now, "automation.changedAt": now, "automation.donorPhase": "running", "automation.zoneIndex": 0 } },
    { returnDocument: "after", lean: true },
  );
  if (!started) return false;
  await recordEvent(started._id, "automation_started", "MarutiX started contacting nearby hospitals, blood banks and registered donors.", { visibleToRequester: true, at: now });
  await recordAudit({ action: "automation.started", outcome: "success", requestId: randomUUID(), resourceType: "emergency_request", resourceId: started.publicRequestId });
  // Discovery runs first (it may geocode the address the donor waves need), then starts wave 1.
  await enqueueJob("discover_institutions", `discover:${requestObjectId}:1`, { requestId: requestObjectId }, { runAt: now });
  return true;
}

export const scheduleFirstWave = (requestObjectId: string, now = new Date()) => enqueueJob("donor_wave", `wave:${requestObjectId}:1`, { requestId: requestObjectId, wave: 1 }, { runAt: now });

export type WaveOutcome = "sent" | "deferred" | "skipped" | "target_reached" | "exhausted" | "limit_reached";

/** Job: one donor wave. Returns "deferred" when alerts are paused globally. */
export async function runDonorWave(requestObjectId: string, waveNumber: number, now = new Date()): Promise<WaveOutcome> {
  await connectToDatabase();
  const request = await EmergencyRequest.findById(requestObjectId).lean();
  if (!request) return "skipped";
  if (!isAlertable(request.status) || request.expiresAt <= now) {
    await EmergencyRequest.updateOne({ _id: request._id }, { $set: { "automation.donorPhase": "stopped" }, $unset: { "automation.nextWaveAt": 1 } });
    return "skipped";
  }
  if (request.automation?.status !== "running") return "skipped";
  if (request.automation.waves.some((w) => w.number === waveNumber)) return "skipped"; // already done (job re-run)
  if ((await getMessagingSettings()).alertsPaused) return "deferred";

  const config = getCoordinationConfig();
  const target = interestTarget(config.targetInterested, request.unitsRequested);
  const setPhase = async (phase: "target_reached" | "exhausted", summary: string) => {
    await EmergencyRequest.updateOne({ _id: request._id }, { $set: { "automation.donorPhase": phase }, $unset: { "automation.nextWaveAt": 1 } });
    await recordEvent(request._id, phase === "target_reached" ? "donor_target_reached" : "donors_exhausted", summary, { visibleToRequester: true, at: now });
  };
  if ((request.responseStats?.interested ?? 0) >= target) {
    await setPhase("target_reached", `${request.responseStats?.interested} donors are interested, so MarutiX has stopped contacting more for now.`);
    return "target_reached";
  }

  const alreadyAlerted = await NotificationEvent.countDocuments({ requestId: request._id.toString(), kind: "emergency_request", status: { $ne: "suppressed" } });
  const allowance = config.alertMaxPerRequest - alreadyAlerted;
  if (allowance <= 0) {
    await setPhase("exhausted", "MarutiX reached its limit of donor alerts for this request. The team will follow up directly.");
    return "limit_reached";
  }

  const zones = config.zonesKm;
  const { run } = await executeMatching(request.publicRequestId, zones.at(-1)!, { trigger: "automatic", requestId: randomUUID() }, now);
  // A request without any location can only be matched by city: that is the last stage.
  const startZone = run.basis === "city" ? zones.length : (request.automation.zoneIndex ?? 0);
  const plan = planWave(
    run.candidates.map((c) => ({ donorUserId: c.donorUserId.toString(), rank: c.rank, distanceKm: run.basis === "city" ? null : (c.distanceKm ?? null) })),
    zones,
    startZone,
    Math.min(config.waveSize, allowance),
  );
  if (plan.exhausted) {
    const alertedAny = (request.automation.waves ?? []).some((w) => (w.queued ?? 0) > 0);
    await setPhase(
      "exhausted",
      alertedAny
        ? "MarutiX has contacted every matching registered donor it could find nearby. Keep working with the hospital's blood bank."
        : "MarutiX hasn't found registered donors matching this request nearby yet. Keep working with the hospital's blood bank; the MarutiX team is also reaching out to hospitals.",
    );
    return "exhausted";
  }

  const summary = alertSummary(request);
  let queued = 0;
  let suppressed = 0;
  for (const c of plan.selected) {
    const result = await queueEmergencyRequestNotification({
      requestId: request._id.toString(),
      donorUserId: new Types.ObjectId(c.donorUserId),
      summary: { ...summary, distanceKm: c.distanceKm },
      matchingRunId: run._id,
      ttlMs: config.alertTtlMs,
    });
    if (result.outcome === "queued") queued += 1;
    else if (result.outcome === "suppressed") suppressed += 1;
    else if (result.status === "failed" && (await requeueUndeliveredAlert(new Types.ObjectId(result.messageId), request, c.distanceKm, now))) queued += 1;
  }

  const nextWaveAt = new Date(now.getTime() + config.waveIntervalMs);
  const zoneKm = plan.zoneIndex < zones.length ? zones[plan.zoneIndex] : null;
  const recorded = await EmergencyRequest.updateOne(
    { _id: request._id, "automation.waves.number": { $ne: waveNumber } },
    {
      $push: { "automation.waves": { number: waveNumber, zoneIndex: plan.zoneIndex, ...(zoneKm !== null ? { zoneKm } : {}), matchingRunId: run._id, queued, suppressed, at: now } },
      $set: { "automation.zoneIndex": plan.zoneIndex, "automation.nextWaveAt": nextWaveAt, "automation.donorPhase": "running" },
      $inc: { "responseStats.alertsQueued": queued },
    },
  );
  if (recorded.modifiedCount === 1) {
    if (plan.zoneIndex > (request.automation.zoneIndex ?? 0)) {
      await recordEvent(request._id, "donor_zone_expanded", `Not enough donors had replied, so MarutiX widened the search to ${zoneLabel(plan.zoneIndex, zones)}.`, { visibleToRequester: true, at: now });
    }
    await recordEvent(request._id, "donor_wave_sent", `Alerted ${queued} registered donor${queued === 1 ? "" : "s"} within ${zoneLabel(plan.zoneIndex, zones)}.`, { visibleToRequester: true, at: now });
  }
  await enqueueJob("donor_wave", `wave:${requestObjectId}:${waveNumber + 1}`, { requestId: requestObjectId, wave: waveNumber + 1 }, { runAt: nextWaveAt });
  return "sent";
}

export const PAUSED_DEFER_MS = 5 * 60_000;

/** Admin controls. All audited. */
export async function controlAutomation(
  publicRequestId: string,
  action: "pause" | "resume" | "cancel" | "run_wave_now" | "rediscover" | "start",
  adminUserId: Types.ObjectId,
  requestId: string,
  now = new Date(),
) {
  await connectToDatabase();
  const request = await EmergencyRequest.findOne({ publicRequestId }).lean();
  if (!request) throw new AppError(404, "NOT_FOUND", "We couldn't find that request.");
  const id = request._id.toString();
  const status = request.automation?.status ?? "not_started";
  const needActive = () => {
    if (!isAlertable(request.status) || request.expiresAt <= now) throw new AppError(409, "INVALID_TRANSITION", "Automation runs only while the request is active.");
  };
  const set = (fields: Record<string, unknown>) => EmergencyRequest.updateOne({ _id: request._id }, { $set: { ...fields, "automation.changedAt": now, "automation.changedBy": adminUserId } });
  const nextWave = () => (request.automation?.waves?.length ?? 0) + 1;

  switch (action) {
    case "start":
      needActive();
      if (status !== "not_started") throw new AppError(409, "CONFLICT", "Automation has already been started for this request.");
      await enqueueJob("coordinate_request", `coordinate:${id}:manual:${now.getTime()}`, { requestId: id }, { runAt: now });
      break;
    case "pause":
      if (status !== "running") throw new AppError(409, "CONFLICT", "Automation isn't running.");
      await set({ "automation.status": "paused" });
      await cancelJobsFor(id, ["donor_wave"]);
      await recordEvent(request._id, "automation_paused", "The MarutiX team paused automatic contacting.", { visibleToRequester: true, actor: "admin", actorUserId: adminUserId, at: now });
      break;
    case "resume":
      needActive();
      if (status !== "paused") throw new AppError(409, "CONFLICT", "Automation isn't paused.");
      await set({ "automation.status": "running", "automation.donorPhase": "running" });
      await enqueueJob("donor_wave", `wave:${id}:${nextWave()}:resume:${now.getTime()}`, { requestId: id, wave: nextWave() }, { runAt: now });
      await enqueueJob("institution_outreach", `outreach:${id}:resume:${now.getTime()}`, { requestId: id }, { runAt: now });
      await recordEvent(request._id, "automation_resumed", "The MarutiX team resumed automatic contacting.", { visibleToRequester: true, actor: "admin", actorUserId: adminUserId, at: now });
      break;
    case "cancel":
      if (status === "cancelled" || status === "completed") throw new AppError(409, "CONFLICT", "Automation has already stopped.");
      await set({ "automation.status": "cancelled", "automation.donorPhase": "stopped" });
      await cancelJobsFor(id, ["donor_wave", "institution_outreach", "send_outreach_email", "discover_institutions"]);
      await withdrawQueuedAlerts(request._id, now);
      await InstitutionOutreach.updateMany({ requestId: request._id, status: { $in: ["queued", "awaiting_review", "no_contact", "channel_unavailable"] } }, { $set: { status: "cancelled" } });
      await recordEvent(request._id, "automation_cancelled", "The MarutiX team stopped automatic contacting for this request.", { visibleToRequester: true, actor: "admin", actorUserId: adminUserId, at: now });
      break;
    case "run_wave_now":
      needActive();
      if (status !== "running") throw new AppError(409, "CONFLICT", "Start or resume automation first.");
      await set({ "automation.donorPhase": "running" });
      await enqueueJob("donor_wave", `wave:${id}:${nextWave()}:manual:${now.getTime()}`, { requestId: id, wave: nextWave() }, { runAt: now });
      break;
    case "rediscover":
      needActive();
      await enqueueJob("discover_institutions", `discover:${id}:manual:${now.getTime()}`, { requestId: id, skipFirstWave: true }, { runAt: now });
      break;
  }
  await recordAudit({ action: "automation.changed", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "emergency_request", resourceId: `${publicRequestId}:${action}` });
}
