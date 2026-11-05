import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const ERROR_SOURCES = ["api", "render", "jobs", "whatsapp_worker", "whatsapp_webhook", "messaging", "coordination"] as const;

/**
 * `error_events`: unexpected server errors grouped by fingerprint (one row per
 * kind of error, with a count). Messages are redacted before they get here;
 * no request bodies, phone numbers, codes or tokens.
 */
const errorEventSchema = new Schema(
  {
    fingerprint: { type: String, required: true },
    source: { type: String, enum: ERROR_SOURCES, required: true },
    event: { type: String, required: true, maxlength: 100 },
    errorName: { type: String, required: true, maxlength: 100 },
    message: { type: String, maxlength: 600 },
    // Route file path or job type, never a URL with parameters.
    where: { type: String, maxlength: 200 },
    count: { type: Number, required: true, default: 0 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    lastRequestId: { type: String },
    alertedAt: { type: Date },
  },
  { collection: "error_events", versionKey: false, strict: "throw" },
);

errorEventSchema.index({ fingerprint: 1 }, { unique: true });
// Errors not seen for 90 days are dropped.
errorEventSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 * 86_400, name: "lastSeenAt_ttl" });

export type ErrorEventDoc = InferSchemaType<typeof errorEventSchema>;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const ErrorEvent: Model<ErrorEventDoc> = (models.ErrorEvent as Model<ErrorEventDoc>) ?? model<ErrorEventDoc>("ErrorEvent", errorEventSchema);
