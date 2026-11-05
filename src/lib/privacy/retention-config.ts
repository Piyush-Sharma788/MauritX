/** How long closed emergency requests keep patient and requester details (REQUEST_RETENTION_DAYS, default 180). */
const DEFAULT_DAYS = 180;

export function requestRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.REQUEST_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_DAYS;
  const days = Number(raw);
  // Under a week would erase details coordinators may still need for follow-up.
  if (!Number.isInteger(days) || days < 7 || days > 3650) throw new Error("REQUEST_RETENTION_DAYS must be a whole number of days between 7 and 3650");
  return days;
}
