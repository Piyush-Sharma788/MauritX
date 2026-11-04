import "server-only";
import { logger } from "@/lib/logger";
import { runDonorWave, scheduleFirstWave, startCoordination, PAUSED_DEFER_MS } from "@/server/coordination/automation";
import { discoverForRequest } from "@/server/discovery/service";
import { claimNextJob, completeJob, deferJob, enqueueJob, failJob, type JobRecord } from "@/server/jobs/queue";
import type { JobType } from "@/server/models/job";
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
};

/** Claims and runs one job. Returns false when nothing is due. */
export async function runOneJob(workerId: string, now = new Date()): Promise<boolean> {
  const job = await claimNextJob(workerId, now);
  if (!job) return false;
  try {
    const outcome = await HANDLERS[job.type](job, now);
    if (outcome === "done") await completeJob(job, new Date());
    else await deferJob(job, outcome.defer);
    logger.info("jobs.ran", { type: job.type, attempt: job.attempts, outcome: outcome === "done" ? "done" : "deferred" });
  } catch (error) {
    const result = await failJob(job, error, new Date());
    logger.warn("jobs.failed", { type: job.type, attempt: job.attempts, result, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
  return true;
}

/** Runs every job due now (tests, and the worker loop). */
export async function runDueJobs(workerId = "inline", now = new Date(), limit = 200): Promise<number> {
  let ran = 0;
  while (ran < limit && (await runOneJob(workerId, now))) ran += 1;
  return ran;
}
