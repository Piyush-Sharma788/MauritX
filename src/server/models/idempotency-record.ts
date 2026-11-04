import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `idempotency_records`: the encrypted response to a create call, keyed by
 * its Idempotency-Key, so a retried submission returns the same result
 * instead of creating a duplicate. Expires after 24 hours.
 */
const idempotencyRecordSchema = new Schema(
  {
    key: { type: String, required: true },
    responseEncrypted: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: "idempotency_records", versionKey: false, strict: "throw" },
);

idempotencyRecordSchema.index({ key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type IdempotencyRecordDoc = InferSchemaType<typeof idempotencyRecordSchema>;

export const IdempotencyRecord: Model<IdempotencyRecordDoc> =
  (models.IdempotencyRecord as Model<IdempotencyRecordDoc>) ?? model<IdempotencyRecordDoc>("IdempotencyRecord", idempotencyRecordSchema);
