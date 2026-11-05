import { CheckIcon } from "@/components/ui/icons";
import { badgeBase } from "@/components/ui/primitives";
import { STATUS_LABELS, type RequestStatus } from "@/features/requests/schemas";
import type { HistoryActor } from "@/features/requests/types";

const STATUS_TONES: Record<RequestStatus, string> = {
  pending_verification: "bg-signal-300 text-ink",
  verified: "bg-mint-100 text-mint-800",
  active: "bg-brand-500 text-white",
  partially_fulfilled: "bg-signal-100 text-signal-800",
  fulfilled: "bg-mint-400 text-ink",
  cancelled: "bg-paper-deep text-ink-soft",
  expired: "bg-paper-deep text-ink-soft",
};

export function StatusBadge({ status, className = "" }: { status: RequestStatus; className?: string }) {
  return (
    <span className={`${badgeBase} ${STATUS_TONES[status]} ${className}`}>
      {status === "fulfilled" ? <CheckIcon className="size-3" strokeWidth={3} /> : <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${status === "active" || status === "pending_verification" ? "animate-pulse" : ""}`} />}
      {STATUS_LABELS[status]}
    </span>
  );
}

const ACTOR_LABELS: Record<HistoryActor, string> = { requester: "Requester", admin: "MarutiX team", institution: "Hospital / blood bank", system: "Automatically" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
export const formatIST = (iso: string) => `${dateTime.format(new Date(iso))} IST`;

/** Newest-first status timeline. Notes are passed only in admin views. */
export function StatusTimeline({ history }: { history: { status: RequestStatus; at: string; actor: HistoryActor; note?: string | null }[] }) {
  const entries = [...history].reverse();
  return (
    <ol className="relative space-y-5 border-l-2 border-ink pl-5">
      {entries.map((entry, i) => (
        <li key={`${entry.at}-${i}`} className="relative">
          <span aria-hidden="true" className={`absolute -left-[1.85rem] top-0.5 size-4 rounded-sm border-2 border-ink ${i === 0 ? "bg-brand-500" : "bg-surface"}`} />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={entry.status} />
            <span className="text-xs text-ink-muted">by {ACTOR_LABELS[entry.actor]}</span>
          </div>
          <p className="mt-1 font-mono text-xs text-ink-soft">{formatIST(entry.at)}</p>
          {entry.note && <p className="mt-1.5 rounded-sm border-l-4 border-ink bg-paper-deep px-3 py-2 text-sm text-ink">{entry.note}</p>}
        </li>
      ))}
    </ol>
  );
}
