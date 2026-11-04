import "server-only";
import { Types } from "mongoose";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Job, type JobDoc, type JobType } from "@/server/models/job";

/**
 * MongoDB-backed job queue. Handlers must be idempotent: a job whose worker
 * died is retried after its lock expires.
 */

export const JOB_LOCK_MS = 5 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const FINISHED_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type JobRecord = JobDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;

/** Thrown by a handler for a failure that retrying can't fix. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Queues a job once per key. Returns false if a job with this key already exists. */
export async function enqueueJob(type: JobType, key: string, payload: Record<string, unknown>, options: { runAt?: Date; maxAttempts?: number } = {}): Promise<boolean> {
  await connectToDatabase();
  try {
    await Job.create({ type, key, payload, status: "queued", runAt: options.runAt ?? new Date(), maxAttempts: options.maxAttempts ?? 5 });
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

/** Claims the next due job, recovering jobs whose worker stopped mid-run. */
export async function claimNextJob(workerId: string, now = new Date(), types?: JobType[]): Promise<JobRecord | null> {
  await Job.updateMany({ status: "running", lockedUntil: { $lte: now } }, { $set: { status: "queued", runAt: now }, $unset: { lockedUntil: 1, lockedBy: 1 } });
  return (await Job.findOneAndUpdate(
    { status: "queued", runAt: { $lte: now }, ...(types ? { type: { $in: types } } : {}) },
    { $set: { status: "running", lockedUntil: new Date(now.getTime() + JOB_LOCK_MS), lockedBy: workerId }, $inc: { attempts: 1 } },
    { sort: { runAt: 1, createdAt: 1 }, returnDocument: "after", lean: true },
  )) as JobRecord | null;
}

export async function completeJob(job: JobRecord, now = new Date()) {
  await Job.updateOne(
    { _id: job._id, status: "running" },
    { $set: { status: "succeeded", finishedAt: now, expiresAt: new Date(now.getTime() + FINISHED_RETENTION_MS) }, $unset: { lockedUntil: 1, lockedBy: 1 } },
  );
}

/** Retries with backoff, or moves the job to the dead-letter state. */
export async function failJob(job: JobRecord, error: unknown, now = new Date()): Promise<"retry" | "dead"> {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError").slice(0, 300);
  const permanent = error instanceof PermanentJobError;
  if (!permanent && job.attempts < job.maxAttempts) {
    const delay = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
    await Job.updateOne({ _id: job._id, status: "running" }, { $set: { status: "queued", runAt: new Date(now.getTime() + delay), lastError: message }, $unset: { lockedUntil: 1, lockedBy: 1 } });
    return "retry";
  }
  await Job.updateOne({ _id: job._id, status: "running" }, { $set: { status: "dead", lastError: message, finishedAt: now }, $unset: { lockedUntil: 1, lockedBy: 1 } });
  return "dead";
}

/** Postpones a running job without counting an attempt (e.g. alerts are paused). */
export async function deferJob(job: JobRecord, until: Date) {
  await Job.updateOne({ _id: job._id, status: "running" }, { $set: { status: "queued", runAt: until }, $inc: { attempts: -1 }, $unset: { lockedUntil: 1, lockedBy: 1 } });
}

/** Admin: give a dead job another full set of attempts. */
export async function retryDeadJob(jobId: string, now = new Date()) {
  await connectToDatabase();
  if (!Types.ObjectId.isValid(jobId)) throw new AppError(404, "NOT_FOUND", "Job not found.");
  const result = await Job.updateOne({ _id: jobId, status: "dead" }, { $set: { status: "queued", runAt: now, attempts: 0 }, $unset: { finishedAt: 1, lastError: 1 } });
  if (result.matchedCount !== 1) throw new AppError(409, "NOT_RETRYABLE", "Only dead jobs can be retried.");
}

/** Cancels pending jobs for a request (e.g. outreach cancelled by an admin). */
export async function cancelJobsFor(requestId: string, types: JobType[]) {
  await Job.updateMany({ status: "queued", type: { $in: types }, "payload.requestId": requestId }, { $set: { status: "cancelled", finishedAt: new Date() } });
}

export async function jobStats(): Promise<{ queued: number; running: number; dead: number }> {
  await connectToDatabase();
  const rows = await Job.aggregate<{ _id: string; count: number }>([{ $match: { status: { $in: ["queued", "running", "dead"] } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
  const get = (s: string) => rows.find((r) => r._id === s)?.count ?? 0;
  return { queued: get("queued"), running: get("running"), dead: get("dead") };
}

export async function listDeadJobs(limit = 20) {
  await connectToDatabase();
  const docs = (await Job.find({ status: "dead" }).sort({ finishedAt: -1 }).limit(limit).lean()) as JobRecord[];
  return docs.map((j) => ({
    id: j._id.toString(),
    type: j.type,
    attempts: j.attempts,
    lastError: j.lastError ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    requestId: typeof (j.payload as { requestId?: unknown })?.requestId === "string" ? ((j.payload as { requestId: string }).requestId) : null,
  }));
}
