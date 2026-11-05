import type { ComponentProps, ReactNode } from "react";
import { AlertIcon, CheckIcon, InfoIcon, ShieldIcon } from "@/components/ui/icons";

/*
 * MarutiX design-system primitives (server-safe, no client state).
 * Shared by the public site, donor portal and admin. Tokens and utilities
 * (brut-card, brut-press, eyebrow, shadow-brut-*) live in app/globals.css.
 */

export type Tone = "neutral" | "brand" | "good" | "warn" | "bad" | "info" | "ink";

/* ---- Typography ---------------------------------------------------------- */

export function Eyebrow({ children, className = "", tone = "brand" }: { children: ReactNode; className?: string; tone?: "brand" | "ink" | "muted" | "light" }) {
  const tones = { brand: "text-brand-600", ink: "text-ink", muted: "text-ink-muted", light: "text-signal-300" };
  return (
    <p className={`eyebrow inline-flex items-center gap-2 ${tones[tone]} ${className}`}>
      <span aria-hidden="true" className="inline-block size-2 bg-current" />
      {children}
    </p>
  );
}

/** Page title block. `children` renders as right-aligned actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
  className = "",
  size = "md",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  size?: "md" | "lg";
}) {
  const titleSize =
    size === "lg"
      ? "text-[2.4rem] leading-[0.98] sm:text-6xl"
      : "text-[2rem] leading-[1.02] sm:text-[2.6rem]";
  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className={`mt-3 text-balance font-display font-extrabold tracking-[-0.045em] text-ink ${titleSize}`}>{title}</h1>
        {description && <div className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-soft">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/* ---- Surfaces ------------------------------------------------------------ */

const cardTones = {
  default: "bg-surface",
  paper: "bg-paper",
  brand: "bg-brand-50",
  signal: "bg-signal-50",
  mint: "bg-mint-50",
  ink: "bg-ink text-white on-dark",
};

export type CardTone = keyof typeof cardTones;

/** Generic block: ink outline + hard shadow. */
export function Panel({
  as: Tag = "section",
  tone = "default",
  shadow = "md",
  className = "",
  children,
  ...props
}: {
  as?: "section" | "div" | "article" | "aside" | "header" | "li";
  tone?: CardTone;
  shadow?: "none" | "sm" | "md" | "lg";
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<"section">, "className" | "children" | "ref">) {
  const shadows = { none: "shadow-none", sm: "shadow-brut-sm", md: "shadow-brut", lg: "shadow-brut-lg" };
  return (
    <Tag className={`rounded-[var(--radius-card)] border-2 border-ink ${cardTones[tone]} ${shadows[shadow]} ${className}`} {...props}>
      {children}
    </Tag>
  );
}

/** Card heading row: title (+ note) on the left, actions on the right. */
export function CardHeader({ title, note, actions, id, as: Tag = "h2" }: { title: ReactNode; note?: ReactNode; actions?: ReactNode; id?: string; as?: "h2" | "h3" }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Tag id={id} className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{title}</Tag>
        {note && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{note}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ---- Status -------------------------------------------------------------- */

const badgeTones: Record<Tone, string> = {
  neutral: "bg-paper-deep text-ink",
  brand: "bg-brand-100 text-brand-700",
  good: "bg-mint-100 text-mint-800",
  warn: "bg-signal-100 text-signal-800",
  bad: "bg-danger-50 text-danger-600",
  info: "bg-surface text-ink",
  ink: "bg-ink text-white",
};

export const badgeBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border-2 border-ink px-2 py-0.5 font-mono text-[0.68rem] font-bold uppercase leading-4 tracking-[0.08em]";

/** Chunky status chip. Pass an icon or a dot so colour is never the only signal. */
export function Badge({ children, tone = "neutral", className = "", dot = false }: { children: ReactNode; tone?: Tone; className?: string; dot?: boolean }) {
  return (
    <span className={`${badgeBase} ${badgeTones[tone]} ${className}`}>
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function badgeClasses(tone: Tone = "neutral") {
  return `${badgeBase} ${badgeTones[tone]}`;
}

/* ---- Notices ------------------------------------------------------------- */

const noticeTones = {
  warn: { box: "bg-signal-50 text-ink", icon: "bg-signal-300 text-ink", Icon: AlertIcon },
  danger: { box: "bg-danger-50 text-ink", icon: "bg-brand-500 text-white", Icon: AlertIcon },
  info: { box: "bg-surface text-ink", icon: "bg-ink text-white", Icon: InfoIcon },
  success: { box: "bg-mint-50 text-ink", icon: "bg-mint-400 text-ink", Icon: CheckIcon },
  shield: { box: "bg-mint-50 text-ink", icon: "bg-mint-400 text-ink", Icon: ShieldIcon },
} as const;

export type NoticeTone = keyof typeof noticeTones;

/** Callout with a solid icon tab on the left. */
export function Notice({
  tone = "info",
  title,
  children,
  className = "",
  size = "md",
  role,
  as: Tag = "div",
  icon,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  size?: "sm" | "md";
  role?: string;
  as?: "div" | "p" | "aside";
  icon?: ReactNode;
}) {
  const t = noticeTones[tone];
  const Icon = t.Icon;
  const pad = size === "sm" ? "text-xs" : "text-sm";
  return (
    <Tag role={role} className={`flex overflow-hidden rounded-md border-2 border-ink leading-relaxed shadow-brut-xs ${t.box} ${pad} ${className}`}>
      <span aria-hidden="true" className={`flex w-10 shrink-0 items-start justify-center border-r-2 border-ink pt-3 ${t.icon}`}>
        {icon ?? <Icon className="size-4.5" strokeWidth={2.25} />}
      </span>
      <span className="min-w-0 flex-1 px-3.5 py-2.5 sm:px-4 sm:py-3">
        {title && <strong className="block font-bold">{title}</strong>}
        {children}
      </span>
    </Tag>
  );
}

/* ---- Data ---------------------------------------------------------------- */

const statTones = {
  neutral: "bg-surface",
  good: "bg-mint-50",
  warn: "bg-signal-100",
  bad: "bg-danger-50",
  brand: "bg-brand-500 text-white",
};

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  className = "",
  as: Tag = "div",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: keyof typeof statTones;
  className?: string;
  as?: "div" | "li";
}) {
  const inverted = tone === "brand";
  return (
    <Tag className={`relative rounded-md border-2 border-ink p-4 shadow-brut-sm ${statTones[tone]} ${className}`}>
      <p className={`text-[0.78rem] font-bold leading-snug ${inverted ? "text-white" : "text-ink-soft"}`}>{label}</p>
      <p className={`mt-1.5 font-display text-3xl font-extrabold leading-none tracking-[-0.04em] tabular-nums ${inverted ? "text-white" : "text-ink"}`}>{value}</p>
      {hint && <p className={`mt-1.5 text-[0.72rem] leading-snug ${inverted ? "text-white" : "text-ink-muted"}`}>{hint}</p>}
    </Tag>
  );
}

export function EmptyBlock({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border-2 border-dashed border-ink/50 bg-paper px-4 py-8 text-center text-sm text-ink-muted ${className}`}>
      <span aria-hidden="true" className="mx-auto mb-2 block font-mono text-lg font-bold text-ink/30">∅</span>
      {children}
    </div>
  );
}

/** Table shell: scrolls horizontally inside its frame, never the page. */
export const table = {
  frame: "overflow-hidden rounded-[var(--radius-card)] border-2 border-ink bg-surface shadow-brut",
  scroll: "overflow-x-auto",
  table: "w-full text-left text-sm",
  head: "border-b-2 border-ink bg-ink text-white",
  th: "whitespace-nowrap px-4 py-2.5 font-mono text-[0.68rem] font-bold uppercase tracking-[0.1em] first:pl-5",
  body: "divide-y divide-line",
  row: "transition-colors hover:bg-signal-50",
  td: "px-4 py-3 align-top first:pl-5",
};

/** Small key/value list. */
export function KeyValue({ items, className = "" }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={`grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 ${className}`}>
      {items.map((item, i) => (
        <div key={i} className="min-w-0 border-l-2 border-ink pl-3">
          <dt className="font-mono text-[0.66rem] font-bold uppercase tracking-[0.1em] text-ink-muted">{item.label}</dt>
          <dd className="mt-0.5 break-words font-semibold text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Centered loading state for Suspense fallbacks. */
export function LoadingBlock({ label = "Loading", className = "min-h-64" }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`} role="status">
      <span className="inline-flex items-center gap-3 rounded-md border-2 border-ink bg-surface px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink shadow-brut-sm">
        <span aria-hidden="true" className="flex gap-1">
          <span className="size-2 animate-pulse bg-brand-500" />
          <span className="size-2 animate-pulse bg-signal-400 [animation-delay:150ms]" />
          <span className="size-2 animate-pulse bg-mint-400 [animation-delay:300ms]" />
        </span>
        {label}…
      </span>
    </div>
  );
}
