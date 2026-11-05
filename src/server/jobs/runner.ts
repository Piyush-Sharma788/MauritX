import "server-only";
import { logger } from "@/lib/logger";
import { runDonorWave, scheduleFirstWave, startCoordination, PAUSED_DEFER_MS } from "@/server/coordination/automation";
import { ensureDiscoverySchedule, runAreaRefresh, runDiscoverySweep } from "@/server/discovery/areas";
import { discoverForRequest } from "@/server/discovery/service";
import { claimNextJob, completeJob, deferJob, enqueueJob, failJob, type JobRecord } from "@/server/jobs/queue";
import { JOB_TYPES, type JobType } from "@/server/models/job";
import { reportError } from "@/server/monitoring/report";
import { runOutreach, sendOutreachEmail } from "@/server/outreach/service";

/**
 * Executes background jobs. Each handler is idempotent and re-checks the
 * request's state, so a retried or duplicated job never double-sends.
 */

type Outcome = "done" | { defer: Date };
type Handler = (job: JobRecord, now: Date) => Promise<Outcome>;

const DISCOVERY_RETRIES = 3;
const requestIdOf = (job: JobRecord) => String((job.payload as { requestId?: unknown }).requestId ?? "");

const HANDLERS: Record<JobType, Handler> = {
  coordinate_request: async (job, now) => {
    await startCoordination(requestIdOf(job), now);
    return "done";
  },
  discover_institutions: async (job, now) => {
    const id = requestIdOf(job);
    try {
      const result = await discoverForRequest(id, now);
      if (result) await enqueueJob("institution_outreach", `outreach:${id}:${job._id.toString()}`, { requestId: id }, { runAt: now });
      // The source failed (public services can be overloaded): try again later. Known institutions were still used.
      const retry = Number((job.payload as { retry?: number }).retry ?? 0);
      if (result?.providerError && retry < DISCOVERY_RETRIES) {
        await enqueueJob("discover_institutions", `discover:${id}:retry:${retry + 1}:${job._id.toString()}`, { requestId: id, skipFirstWave: true, retry: retry + 1 }, { runAt: new Date(now.getTime() + (retry + 1) * 5 * 60_000) });
      }
    } finally {
      // Donor waves must not depend on discovery succeeding.
      if (!(job.payload as { skipFirstWave?: boolean }).skipFirstWave) await scheduleFirstWave(id, now);
    }
    return "done";
  },
  institution_outreach: async (job, now) => {
    await runOutreach(requestIdOf(job), now);
    return "done";
  },
  send_outreach_email: async (job, now) => {
    const p = job.payload as { outreachId: string; deliveryId: string };
    const outcome = await sendOutreachEmail(p.outreachId, p.deliveryId, { number: job.attempts, max: job.maxAttempts }, now);
    if (outcome.kind === "retry") throw outcome.error;
    return outcome.kind === "defer" ? { defer: outcome.until } : "done";
  },
  donor_wave: async (job, now) => {
    const p = job.payload as { requestId: string; wave: number };
    const outcome = await runDonorWave(p.requestId, p.wave, now);
    return outcome === "deferred" ? { defer: new Date(now.getTime() + PAUSED_DEFER_MS) } : "done";
  },
  // Background area discovery: derive areas, queue a few due ones (see discovery/areas.ts).
  discovery_sweep: async (_job, now) => {
    await runDiscoverySweep(now);
    return "done";
  },
  // One area: throttling and source failures are recorded on the area and backed off there, not retried here.
  discovery_area_refresh: async (job, now) => {
    await runAreaRefresh(String((job.payload as { areaKey?: unknown }).areaKey ?? ""), now);
    return "done";
  },
};

const SCHEDULE_CHECK_MS = 10 * 60_000;
let nextScheduleCheckAt = 0;

/** Keeps the periodic discovery sweep queued (only with a real provider and DISCOVERY_AREA_REFRESH=true). */
async function maybeEnsureSchedules(now: Date) {
  if (Date.now() < nextScheduleCheckAt) return;
  nextScheduleCheckAt = Date.now() + SCHEDULE_CHECK_MS;
  try {
    await ensureDiscoverySchedule(now);
  } catch (error) {
    logger.warn("jobs.schedule_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

/** Claims and runs one job. Returns false when nothing is due. */
/**
 * Job lanes. The jobs worker runs one loop per lane, so slow external calls never hold
 * up time-critical work for an open emergency.
 * - urgent: coordination, donor waves, outreach email: seconds matter.
 * - requestDiscovery: OpenStreetMap search for one emergency (can take a minute).
 * - background: scheduled area discovery and refresh (best effort, can take minutes).
 */
export const JOB_LANES = {
  urgent: JOB_TYPES.filter((t) => t !== "discover_institutions" && t !== "discovery_sweep" && t !== "discovery_area_refresh"),
  requestDiscovery: ["discover_institutions"],
  background: ["discovery_sweep", "discovery_area_refresh"],
} as const satisfies Record<string, readonly JobType[]>;
export type JobLane = keyof typeof JOB_LANES;

/**
 * Claims and runs one due job. `types` restricts which jobs this call may take, so the
 * worker can run separate lanes and a slow discovery refresh never delays a donor wave.
 */
export async function runOneJob(workerId: string, now = new Date(), types?: readonly JobType[]): Promise<boolean> {
  await maybeEnsureSchedules(now);
  const job = await claimNextJob(workerId, now, types ? [...types] : undefined);
  if (!job) return false;
  try {
    const outcome = await HANDLERS[job.type](job, now);
    if (outcome === "done") await completeJob(job, new Date());
    else await deferJob(job, outcome.defer);
    logger.info("jobs.ran", { type: job.type, attempt: job.attempts, outcome: outcome === "done" ? "done" : "deferred" });
  } catch (error) {
    const result = await failJob(job, error, new Date());
    logger.warn("jobs.failed", { type: job.type, attempt: job.attempts, result, errorName: error instanceof Error ? error.name : "UnknownError" });
    // A job out of retries needs a person: coordination for that request has stopped.
    if (result === "dead") await reportError(error, { source: job.type === "donor_wave" || job.type === "coordinate_request" ? "coordination" : "jobs", event: "jobs.dead", where: job.type });
  }
  return true;
}

/** Runs every job due now (tests, and the worker loop). */
export async function runDueJobs(workerId = "inline", now = new Date(), limit = 200): Promise<number> {
  let ran = 0;
  while (ran < limit && (await runOneJob(workerId, now))) ran += 1;
  return ran;
}
