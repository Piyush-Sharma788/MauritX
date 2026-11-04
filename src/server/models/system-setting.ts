import { Schema, Types, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `system_settings`: operational switches admins control at runtime. A single
 * document, `_id: "messaging"`. STOP handling is never affected by these.
 */
const systemSettingSchema = new Schema(
  {
    _id: { type: String, required: true },
    // Off: the bot only honours STOP; other inbound messages are dropped unanswered.
    botEnabled: { type: Boolean, required: true, default: true },
    // On: no emergency alerts are dispatched or newly queued.
    alertsPaused: { type: Boolean, required: true, default: false },
    updatedBy: { type: Types.ObjectId, ref: "User" },
  },
  { collection: "system_settings", timestamps: true, strict: "throw", _id: false },
);

export type SystemSettingDoc = InferSchemaType<typeof systemSettingSchema>;

export const SystemSetting: Model<SystemSettingDoc> =
  (models.SystemSetting as Model<SystemSettingDoc>) ?? model<SystemSettingDoc>("SystemSetting", systemSettingSchema);
