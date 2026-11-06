import { Ban, CalendarClock, Check, CircleCheck, Clock, Siren, UserRoundCheck, Zap, type LucideIcon } from "lucide-react";
import { badgeBase } from "@/components/ui/primitives";
import { PRIORITY_LABELS, STATUS_LABELS, type Priority, type RequestStatus } from "@/features/requests/schemas";
import type { HistoryActor } from "@/features/requests/types";

/*
 * Request state, at a glance. Every status maps to one of five stages, and each
 * stage pairs a colour with an icon and a word, so colour is never the only signal:
 *   urgent (active, finding donors) · pending (awaiting verification or activation)
 *   matched (some donors / units arranged) · completed (fulfilled) · closed (cancelled, expired)
 */
export type RequestStage = "urgent" | "pending" | "matched" | "completed" | "closed";

export const STATUS_STAGE: Record<RequestStatus, RequestStage> = {
  pending_verification: "pending",
  verified: "pending",
  active: "urgent",
  partially_fulfilled: "matched",
  fulfilled: "completed",
  cancelled: "closed",
  expired: "closed",
};

export const STAGE_STYLES: Record<RequestStage, { label: string; Icon: LucideIcon; badge: string; text: string; dot: string; bar: string }> = {
  urgent: { label: "Urgent", Icon: Siren, badge: "border-brand-200 bg-brand-50 text-brand-700", text: "text-brand-600", dot: "bg-brand-500", bar: "bg-brand-500" },
  pending: { label: "Pending", Icon: Clock, badge: "border-warning-200 bg-warning-50 text-warning-800", text: "text-warning-800", dot: "bg-warning-500", bar: "bg-warning-500" },
  matched: { label: "Matched", Icon: UserRoundCheck, badge: "border-info-200 bg-info-50 text-info-700", text: "text-info-700", dot: "bg-info-600", bar: "bg-info-600" },
  completed: { label: "Completed", Icon: CircleCheck, badge: "border-mint-300 bg-mint-50 text-mint-800", text: "text-mint-800", dot: "bg-success-600", bar: "bg-success-600" },
  closed: { label: "Closed", Icon: Ban, badge: "border-line bg-paper-deep text-signal-800", text: "text-ink-muted", dot: "bg-ink-muted", bar: "bg-line-strong" },
};

function PulseDot({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative flex size-2 ${className}`}>
      <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-50" />
      <span className="relative size-2 rounded-full bg-current" />
    </span>
  );
}

/** The exact status, styled by its stage. */
export function StatusBadge({ status, className = "" }: { status: RequestStatus; className?: string }) {
  const stage = STATUS_STAGE[status];
  const { Icon, badge } = STAGE_STYLES[stage];
  return (
    <span className={`${badgeBase} ${badge} ${className}`}>
      {stage === "urgent" ? <PulseDot /> : <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.25} />}
      {STATUS_LABELS[status]}
    </span>
  );
}

/** The stage word on its own (Urgent, Pending, Matched, Completed, Closed), for cards and lists. */
export function StageIndicator({ status, className = "" }: { status: RequestStatus; className?: string }) {
  const stage = STATUS_STAGE[status];
  const { label, text } = STAGE_STYLES[stage];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${text} ${className}`}>
      {stage === "urgent" ? <PulseDot /> : <span aria-hidden="true" className={`size-2 rounded-full ${STAGE_STYLES[stage].dot}`} />}
      {label}
    </span>
  );
}

const PRIORITY_STYLES: Record<Priority, { badge: string; Icon: LucideIcon }> = {
  critical: { badge: "border-brand-600 bg-brand-500 text-white", Icon: Siren },
  urgent: { badge: "border-brand-200 bg-brand-50 text-brand-700", Icon: Zap },
  scheduled: { badge: "border-line bg-paper-deep text-signal-800", Icon: CalendarClock },
};

/** How soon the blood is needed: critical (hours), urgent (24 h) or scheduled. */
export function PriorityBadge({ priority, className = "" }: { priority: Priority; className?: string }) {
  const { badge, Icon } = PRIORITY_STYLES[priority];
  return (
    <span className={`${badgeBase} ${badge} ${className}`} title={PRIORITY_LABELS[priority].description}>
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
      {PRIORITY_LABELS[priority].label}
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
    <ol className="relative space-y-5">
      {entries.map((entry, i) => {
        const stage = STATUS_STAGE[entry.status];
        return (
          <li key={`${entry.at}-${i}`} className="relative pl-7">
            {i < entries.length - 1 && <span aria-hidden="true" className="absolute bottom-[-1.25rem] left-[0.4375rem] top-5 w-px bg-line" />}
            <span aria-hidden="true" className={`absolute left-0 top-1 flex size-3.5 items-center justify-center rounded-full ring-4 ring-surface ${i === 0 ? STAGE_STYLES[stage].dot : "bg-line-strong"}`} />
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={entry.status} />
              <span className="text-xs text-ink-muted">by {ACTOR_LABELS[entry.actor]}</span>
            </div>
            <p className="mt-1 text-xs tabular-nums text-ink-muted">{formatIST(entry.at)}</p>
            {entry.note && <p className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink">{entry.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}

type StepState = "done" | "current" | "upcoming" | "skipped";

/**
 * Where a request stands, from received to blood arranged. Derived only from
 * data the page already has (status, history and coordination counts).
 */
export function RequestProgress({
  status,
  history = [],
  donorsAlerted = null,
  donorsInterested = null,
  zone = null,
  className = "",
}: {
  status: RequestStatus;
  history?: { status: RequestStatus }[];
  donorsAlerted?: number | null;
  donorsInterested?: number | null;
  zone?: string | null;
  className?: string;
}) {
  const reached = new Set<RequestStatus>([...history.map((h) => h.status), status]);
  const reachedAny = (...s: RequestStatus[]) => s.some((x) => reached.has(x));
  const closed = status === "cancelled" || status === "expired";
  const live = reachedAny("verified", "active", "partially_fulfilled", "fulfilled");
  const alerted = (donorsAlerted ?? 0) > 0 || reachedAny("partially_fulfilled", "fulfilled");
  const matched = (donorsInterested ?? 0) > 0 || reachedAny("partially_fulfilled", "fulfilled");
  const fulfilled = status === "fulfilled";

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const steps: { label: string; detail: string; done: boolean }[] = [
    { label: "Request received", detail: "Logged by MarutiX", done: true },
    { label: "Verified & live", detail: live ? "Coordination has started" : "Awaiting verification", done: live },
    {
      label: "Donors alerted",
      detail: alerted ? `${donorsAlerted ? plural(donorsAlerted, "donor") : "Donors"} alerted${zone ? ` · ${zone}` : ""}` : "Searching for donors nearby",
      done: alerted,
    },
    { label: "Donor matched", detail: matched ? (donorsInterested ? `${plural(donorsInterested, "donor")} interested` : "Donors have responded") : "Waiting for replies", done: matched },
    { label: "Blood arranged", detail: fulfilled ? "Marked fulfilled" : "Once the hospital confirms", done: fulfilled },
  ];
  const firstOpen = steps.findIndex((s) => !s.done);
  const stateOf = (i: number): StepState => (steps[i].done ? "done" : closed ? "skipped" : i === firstOpen ? "current" : "upcoming");
  const urgent = STATUS_STAGE[status] === "urgent";

  const circle: Record<StepState, string> = {
    done: "border-success-600 bg-success-600 text-white",
    current: urgent ? "border-brand-500 bg-surface text-brand-600 shadow-brut-brand" : "border-warning-500 bg-surface text-warning-800",
    upcoming: "border-line-strong bg-surface text-ink-muted",
    skipped: "border-dashed border-line-strong bg-paper text-ink-muted",
  };
  const srState: Record<StepState, string> = { done: "done", current: "in progress", upcoming: "not yet", skipped: "not reached" };

  return (
    <div className={className}>
      <ol aria-label="Request progress" className="grid gap-0 sm:grid-cols-5">
        {steps.map((step, i) => {
          const state = stateOf(i);
          const last = i === steps.length - 1;
          return (
            <li key={step.label} className="relative flex gap-3 pb-5 last:pb-0 sm:block sm:pb-0 sm:pr-3">
              {!last && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[0.9375rem] top-8 h-[calc(100%-2rem)] w-px sm:left-9 sm:right-0 sm:top-[0.9375rem] sm:h-px sm:w-auto ${steps[i + 1].done ? "bg-success-600" : "bg-line-strong"}`}
                />
              )}
              <span aria-hidden="true" className={`relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${circle[state]}`}>
                {state === "done" ? <Check className="size-4" strokeWidth={2.75} /> : state === "current" && urgent ? <span className="size-2.5 animate-pulse rounded-full bg-brand-500" /> : i + 1}
              </span>
              <span className="block min-w-0 sm:mt-2.5">
                <span className={`block text-sm font-semibold ${state === "upcoming" || state === "skipped" ? "text-ink-muted" : "text-ink"}`}>
                  {step.label}
                  <span className="sr-only"> ({srState[state]})</span>
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{step.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {closed && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink-soft">
          <Ban aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
          This request was {status === "cancelled" ? "cancelled" : "closed when it expired"}. No more alerts go out for it.
        </p>
      )}
    </div>
  );
}
