import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

// "admin" is the pre-split role, treated as super_admin (src/lib/auth/permissions.ts).
export const USER_ROLES = ["donor", "institution_user", "coordinator", "super_admin", "admin"] as const;
export const USER_STATUSES = ["active", "paused", "suspended", "deleted"] as const;

/**
 * `users` (DATABASE_SCHEMA.md §1). The phone number is never stored in
 * plaintext: `phoneLookup` is a keyed deterministic token that carries the
 * unique constraint, and `phoneEncrypted` is AES-256-GCM ciphertext.
 */
const userSchema = new Schema(
  {
    phoneLookup: { type: String, required: true },
    phoneEncrypted: { type: String, required: true },
    phoneVerifiedAt: { type: Date, required: true },
    role: { type: String, enum: USER_ROLES, required: true, default: "donor" },
    status: { type: String, enum: USER_STATUSES, required: true, default: "active" },
    displayName: { type: String, trim: true, maxlength: 60 },
    deletedAt: { type: Date },
    // Admin two-factor authentication (TOTP). Secrets are encrypted; recovery codes are keyed hashes.
    mfa: {
      secretEncrypted: { type: String },
      pendingSecretEncrypted: { type: String },
      enabledAt: { type: Date },
      recoveryCodeHashes: { type: [String], default: undefined },
      // Last accepted 30-second step: a code can't be used twice.
      lastUsedStep: { type: Number },
    },
  },
  { collection: "users", timestamps: true, strict: "throw" },
);

userSchema.index({ phoneLookup: 1 }, { unique: true });
userSchema.index({ role: 1 });
userSchema.index({ status: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;

export const User: Model<UserDoc> = (models.User as Model<UserDoc>) ?? model<UserDoc>("User", userSchema);
