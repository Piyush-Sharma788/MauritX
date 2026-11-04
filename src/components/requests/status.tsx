import { CheckIcon } from "@/components/ui/icons";
import { STATUS_LABELS, type RequestStatus } from "@/features/requests/schemas";
import type { HistoryActor } from "@/features/requests/types";

const STATUS_TONES: Record<RequestStatus, string> = {
  pending_verification: "bg-warning-50 text-warning-800 ring-warning-200",
  verified: "bg-success-50 text-success-600 ring-success-600/20",
  active: "bg-brand-50 text-brand-700 ring-brand-200",
  partially_fulfilled: "bg-warning-50 text-warning-800 ring-warning-200",
  fulfilled: "bg-success-600 text-white ring-success-600",
  cancelled: "bg-paper-deep text-ink-soft ring-line-strong",
  expired: "bg-paper-deep text-ink-soft ring-line-strong",
};

export function StatusBadge({ status, className = "" }: { status: RequestStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STATUS_TONES[status]} ${className}`}>
      {status === "fulfilled" && <CheckIcon className="size-3" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

const ACTOR_LABELS: Record<HistoryActor, string> = { requester: "Requester", admin: "MarutiX team", system: "Automatically" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
export const formatIST = (iso: string) => `${dateTime.format(new Date(iso))} IST`;

/** Newest-first status timeline. Notes are passed only in admin views. */
export function StatusTimeline({ history }: { history: { status: RequestStatus; at: string; actor: HistoryActor; note?: string | null }[] }) {
  const entries = [...history].reverse();
  return (
    <ol className="relative space-y-5 border-l border-line pl-5">
      {entries.map((entry, i) => (
        <li key={`${entry.at}-${i}`} className="relative">
          <span className={`absolute -left-[1.6rem] top-1 size-3 rounded-full ring-4 ring-surface ${i === 0 ? "bg-brand-500" : "bg-line-strong"}`} />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={entry.status} />
            <span className="text-xs text-ink-muted">by {ACTOR_LABELS[entry.actor]}</span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">{formatIST(entry.at)}</p>
          {entry.note && <p className="mt-1.5 rounded-lg bg-paper-deep/70 px-3 py-2 text-sm text-ink">{entry.note}</p>}
        </li>
      ))}
    </ol>
  );
}
