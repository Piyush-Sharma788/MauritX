import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const JOB_TYPES = ["coordinate_request", "discover_institutions", "institution_outreach", "send_outreach_email", "donor_wave"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_STATUSES = ["queued", "running", "succeeded", "dead", "cancelled"] as const;

/**
 * `jobs`: the MongoDB-backed background queue. A unique `key` makes enqueueing
 * idempotent. Failed jobs retry with backoff; after `maxAttempts` they become
 * `dead` (the dead-letter state) and wait for an admin. Payloads hold IDs only,
 * never personal data.
 */
const jobSchema = new Schema(
  {
    type: { type: String, enum: JOB_TYPES, required: true },
    key: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true, default: {} },
    status: { type: String, enum: JOB_STATUSES, required: true, default: "queued" },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 5 },
    runAt: { type: Date, required: true },
    lockedUntil: { type: Date },
    lockedBy: { type: String },
    lastError: { type: String, maxlength: 300 },
    finishedAt: { type: Date },
    // Finished jobs are removed after 30 days; dead ones are kept until handled.
    expiresAt: { type: Date },
  },
  { collection: "jobs", timestamps: true, strict: "throw", minimize: false },
);

jobSchema.index({ key: 1 }, { unique: true });
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
jobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type JobDoc = InferSchemaType<typeof jobSchema>;

export const Job: Model<JobDoc> = (models.Job as Model<JobDoc>) ?? model<JobDoc>("Job", jobSchema);
