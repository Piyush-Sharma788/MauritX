import type { ReactNode } from "react";

/** Shared building blocks for admin pages. Server-safe (no client state). */

export function Card({ title, note, children, actions, id }: { title: string; note?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-soft sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={id} className="font-semibold text-ink">{title}</h2>
          {note && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
        </div>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: ReactNode; hint?: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  const tones = {
    neutral: "border-line bg-surface",
    good: "border-success-600/20 bg-success-50",
    warn: "border-warning-200 bg-warning-50",
    bad: "border-danger-600/20 bg-danger-50",
  };
  return (
    <div className={`rounded-2xl border p-4 ${tones[tone]}`}>
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold tracking-tight text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[0.7rem] text-ink-muted">{hint}</p>}
    </div>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "brand" }) {
  const tones = {
    neutral: "bg-paper-deep text-ink-soft",
    good: "bg-success-50 text-success-600",
    warn: "bg-warning-50 text-warning-800",
    bad: "bg-danger-50 text-danger-600",
    brand: "bg-brand-50 text-brand-700",
  };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">{eyebrow}</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.035em] text-ink sm:text-4xl">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-muted">{children}</p>;
}
