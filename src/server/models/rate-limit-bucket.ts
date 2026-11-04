import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `rate_limits`: fixed-window counters. SYSTEM_DESIGN.md places rate limits in
 * Redis; until Redis is provisioned this MongoDB-backed store keeps limits
 * correct across multiple app instances. Keys are keyed hashes, so no phone
 * numbers or IP addresses are stored.
 */
const rateLimitBucketSchema = new Schema(
  {
    key: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { collection: "rate_limits", versionKey: false, strict: "throw" },
);

rateLimitBucketSchema.index({ key: 1 }, { unique: true });
rateLimitBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RateLimitBucketDoc = InferSchemaType<typeof rateLimitBucketSchema>;

export const RateLimitBucket: Model<RateLimitBucketDoc> =
  (models.RateLimitBucket as Model<RateLimitBucketDoc>) ??
  model<RateLimitBucketDoc>("RateLimitBucket", rateLimitBucketSchema);
