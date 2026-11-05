import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const BOT_METRICS = [
  "inbound_processed",
  "inbound_dropped_disabled",
  "inbound_unsupported",
  "inbound_dropped_empty",
  "bot_errors",
  "ai_calls",
  "ai_errors",
  "ai_rejected_output",
  "welcome_media_queued",
  "media_fallback_text",
] as const;
export type BotMetricName = (typeof BOT_METRICS)[number];

/**
 * `bot_metrics`: per-day counters (IST day, `_id: "YYYY-MM-DD"`) for the
 * admin dashboard. Counts only; no content or identifiers.
 */
const botMetricSchema = new Schema(
  {
    _id: { type: String, required: true },
    counts: { type: Map, of: Number, default: {} },
    expiresAt: { type: Date, required: true },
  },
  { collection: "bot_metrics", strict: "throw", _id: false, versionKey: false },
);

botMetricSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type BotMetricDoc = InferSchemaType<typeof botMetricSchema>;

export const BotMetric: Model<BotMetricDoc> =
  (models.BotMetric as Model<BotMetricDoc>) ?? model<BotMetricDoc>("BotMetric", botMetricSchema);
