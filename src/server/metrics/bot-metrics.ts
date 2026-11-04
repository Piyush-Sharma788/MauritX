import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { BotMetric, type BotMetricName } from "@/server/models/bot-metric";

const istDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Best-effort counter; a metrics failure never affects message handling. */
export async function incrementMetric(name: BotMetricName, now = new Date()): Promise<void> {
  try {
    await connectToDatabase();
    await BotMetric.updateOne(
      { _id: istDay.format(now) },
      { $inc: { [`counts.${name}`]: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + RETENTION_MS) } },
      { upsert: true },
    );
  } catch (error) {
    logger.warn("metrics.increment_failed", { metric: name, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

/** Totals for today (IST) and the last 7 days, including today. */
export async function readMetrics(now = new Date()): Promise<{ today: Record<string, number>; last7Days: Record<string, number> }> {
  await connectToDatabase();
  const days = Array.from({ length: 7 }, (_, i) => istDay.format(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  const docs = await BotMetric.find({ _id: { $in: days } }).lean();
  const today: Record<string, number> = {};
  const last7Days: Record<string, number> = {};
  for (const doc of docs) {
    const counts = doc.counts instanceof Map ? Object.fromEntries(doc.counts) : (doc.counts as Record<string, number>);
    for (const [k, v] of Object.entries(counts ?? {})) {
      last7Days[k] = (last7Days[k] ?? 0) + v;
      if (doc._id === days[0]) today[k] = (today[k] ?? 0) + v;
    }
  }
  return { today, last7Days };
}
