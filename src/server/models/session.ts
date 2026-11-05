import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `sessions`: server-side, revocable browser sessions. The cookie holds an
 * opaque random token; only its keyed hash is stored here.
 */
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    userId: { type: Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    // Last authenticated use, for the idle timeout (updated at most every few minutes).
    lastSeenAt: { type: Date },
    revokedReason: { type: String, enum: ["logout", "rotated", "idle", "max_age", "role_changed", "phone_changed"] },
  },
  { collection: "sessions", timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = InferSchemaType<typeof sessionSchema>;

export const Session: Model<SessionDoc> =
  (models.Session as Model<SessionDoc>) ?? model<SessionDoc>("Session", sessionSchema);
