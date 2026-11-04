import "server-only";
import type { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { SystemSetting } from "@/server/models/system-setting";
import { recordAudit } from "@/server/services/audit";

const ID = "messaging";

export interface MessagingSettings {
  botEnabled: boolean;
  alertsPaused: boolean;
  updatedAt: string | null;
}

const DEFAULTS = { botEnabled: true, alertsPaused: false };

/** Current switches. A missing document means the defaults (bot on, alerts not paused). */
export async function getMessagingSettings(): Promise<MessagingSettings> {
  await connectToDatabase();
  const doc = await SystemSetting.findById(ID).lean();
  return {
    botEnabled: doc?.botEnabled ?? DEFAULTS.botEnabled,
    alertsPaused: doc?.alertsPaused ?? DEFAULTS.alertsPaused,
    updatedAt: (doc as { updatedAt?: Date } | null)?.updatedAt?.toISOString() ?? null,
  };
}

export async function updateMessagingSettings(
  patch: { botEnabled?: boolean; alertsPaused?: boolean },
  adminUserId: Types.ObjectId,
  requestId: string,
): Promise<MessagingSettings> {
  await connectToDatabase();
  const before = await getMessagingSettings();
  await SystemSetting.updateOne(
    { _id: ID },
    { $set: { ...patch, updatedBy: adminUserId }, $setOnInsert: { _id: ID } },
    { upsert: true },
  );
  if (patch.botEnabled !== undefined && patch.botEnabled !== before.botEnabled) {
    await recordAudit({ action: "settings.bot_enabled_changed", outcome: "success", requestId, actorUserId: adminUserId, resourceId: patch.botEnabled ? "on" : "off" });
  }
  if (patch.alertsPaused !== undefined && patch.alertsPaused !== before.alertsPaused) {
    await recordAudit({ action: "settings.alerts_paused_changed", outcome: "success", requestId, actorUserId: adminUserId, resourceId: patch.alertsPaused ? "paused" : "running" });
  }
  return getMessagingSettings();
}
