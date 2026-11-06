import type { ReactNode } from "react";
import { Badge, CardHeader, EmptyBlock, PageHeader as BasePageHeader, StatTile } from "@/components/ui/primitives";

/** Shared building blocks for admin pages. Server-safe (no client state). Built on src/components/ui/primitives. */

export function Card({ title, note, children, actions, id }: { title: string; note?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-brut-xs sm:p-5">
      <CardHeader id={id} title={title} note={note} actions={actions} />
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: ReactNode; hint?: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return <StatTile label={label} value={value} hint={hint} tone={tone} />;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "brand" }) {
  return <Badge tone={tone}>{children}</Badge>;
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <BasePageHeader eyebrow={eyebrow} title={title}>
      {children}
    </BasePageHeader>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <EmptyBlock>{children}</EmptyBlock>;
}
