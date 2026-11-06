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
  const tones = { brand: "text-brand-600", ink: "text-ink", muted: "text-ink-muted", light: "text-brand-200" };
  return (
    <p className={`eyebrow inline-flex items-center gap-2 ${tones[tone]} ${className}`}>
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-current" />
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
      ? "text-[2.25rem] leading-[1.05] sm:text-[3.25rem]"
      : "text-[1.75rem] leading-[1.15] sm:text-[2.125rem]";
  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className={`mt-2 text-balance font-display font-semibold tracking-[-0.03em] text-ink ${titleSize}`}>{title}</h1>
        {description && <div className="mt-3 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-lg">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/* ---- Surfaces ------------------------------------------------------------ */

const cardTones = {
  default: "border-line bg-surface",
  paper: "border-line bg-paper",
  brand: "border-brand-100 bg-brand-50",
  signal: "border-line bg-signal-50",
  mint: "border-mint-100 bg-mint-50",
  ink: "border-ink bg-ink text-white on-dark",
};

export type CardTone = keyof typeof cardTones;

/** Generic card: one hairline border, soft elevation. */
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
  const shadows = { none: "shadow-none", sm: "shadow-brut-xs", md: "shadow-brut-xs", lg: "shadow-brut-sm" };
  return (
    <Tag className={`rounded-[var(--radius-card)] border ${cardTones[tone]} ${shadows[shadow]} ${className}`} {...props}>
      {children}
    </Tag>
  );
}

/** Card heading row: title (+ note) on the left, actions on the right. */
export function CardHeader({ title, note, actions, id, as: Tag = "h2" }: { title: ReactNode; note?: ReactNode; actions?: ReactNode; id?: string; as?: "h2" | "h3" }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Tag id={id} className="font-display text-base font-semibold tracking-[-0.01em] text-ink sm:text-[1.05rem]">{title}</Tag>
        {note && <p className="mt-1 text-[0.8rem] leading-relaxed text-ink-muted">{note}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ---- Status -------------------------------------------------------------- */

const badgeTones: Record<Tone, string> = {
  neutral: "border-line bg-paper-deep text-signal-800",
  brand: "border-brand-200 bg-brand-50 text-brand-700",
  good: "border-mint-300 bg-mint-50 text-mint-800",
  warn: "border-warning-200 bg-warning-50 text-warning-800",
  bad: "border-brand-200 bg-danger-50 text-brand-700",
  info: "border-info-200 bg-info-50 text-info-700",
  ink: "border-ink bg-ink text-white",
};

export const badgeBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-4";

/** Status pill. Pass an icon or a dot so colour is never the only signal. */
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
  warn: { box: "border-warning-200 bg-warning-50", icon: "bg-warning-100 text-warning-800", Icon: AlertIcon },
  danger: { box: "border-brand-200 bg-brand-50", icon: "bg-brand-100 text-brand-600", Icon: AlertIcon },
  info: { box: "border-line bg-surface", icon: "bg-info-50 text-info-700", Icon: InfoIcon },
  success: { box: "border-mint-300 bg-mint-50", icon: "bg-mint-100 text-mint-800", Icon: CheckIcon },
  shield: { box: "border-mint-300 bg-mint-50", icon: "bg-mint-100 text-mint-800", Icon: ShieldIcon },
} as const;

export type NoticeTone = keyof typeof noticeTones;

/** Callout with a tinted icon on the left. */
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
    <Tag role={role} className={`flex gap-3 rounded-xl border px-3.5 py-3 leading-relaxed text-ink sm:px-4 ${t.box} ${pad} ${className}`}>
      <span aria-hidden="true" className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${t.icon}`}>
        {icon ?? <Icon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1 self-center">
        {title && <strong className="block font-semibold">{title}</strong>}
        {children}
      </span>
    </Tag>
  );
}

/* ---- Data ---------------------------------------------------------------- */

const statTones = {
  neutral: { box: "border-line bg-surface", icon: "bg-signal-100 text-signal-800" },
  good: { box: "border-line bg-surface", icon: "bg-mint-50 text-mint-800" },
  warn: { box: "border-line bg-surface", icon: "bg-warning-50 text-warning-800" },
  bad: { box: "border-brand-200 bg-brand-50/50", icon: "bg-brand-100 text-brand-600" },
  info: { box: "border-line bg-surface", icon: "bg-info-50 text-info-700" },
  brand: { box: "border-brand-600 bg-brand-500 text-white", icon: "bg-white/15 text-white" },
};

const statAccent = {
  neutral: "",
  good: "text-mint-800",
  warn: "text-warning-800",
  bad: "text-brand-600",
  info: "text-info-700",
  brand: "text-white",
};

/** A metric card. `icon` is optional; the value colour follows the tone. */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  className = "",
  as: Tag = "div",
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: keyof typeof statTones;
  className?: string;
  as?: "div" | "li";
  icon?: ReactNode;
}) {
  const inverted = tone === "brand";
  const t = statTones[tone];
  return (
    <Tag className={`relative rounded-xl border p-4 shadow-brut-xs ${t.box} ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <p className={`text-[0.8rem] font-medium leading-snug ${inverted ? "text-white/90" : "text-ink-soft"}`}>{label}</p>
        {icon && <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${t.icon}`}>{icon}</span>}
      </div>
      <p className={`mt-2 font-display text-[1.75rem] font-semibold leading-none tracking-[-0.03em] tabular-nums ${inverted ? "text-white" : statAccent[tone] || "text-ink"}`}>{value}</p>
      {hint && <p className={`mt-1.5 text-xs leading-snug ${inverted ? "text-white/85" : "text-ink-muted"}`}>{hint}</p>}
    </Tag>
  );
}

export function EmptyBlock({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-dashed border-line-strong bg-paper px-4 py-8 text-center text-sm text-ink-muted ${className}`}>
      {children}
    </div>
  );
}

/** Table shell: scrolls horizontally inside its frame, never the page. */
export const table = {
  frame: "overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-brut-xs",
  scroll: "overflow-x-auto",
  table: "w-full text-left text-sm",
  head: "border-b border-line bg-paper text-ink-muted",
  th: "whitespace-nowrap px-4 py-2.5 text-xs font-medium first:pl-5",
  body: "divide-y divide-line",
  row: "transition-colors hover:bg-signal-50",
  td: "px-4 py-3 align-top first:pl-5",
};

/** Small key/value list. */
export function KeyValue({ items, className = "" }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={`grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 ${className}`}>
      {items.map((item, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-ink-muted">{item.label}</dt>
          <dd className="mt-0.5 break-words font-medium text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Centered loading state for Suspense fallbacks. */
export function LoadingBlock({ label = "Loading", className = "min-h-64" }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`} role="status">
      <span className="inline-flex items-center gap-3 rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink-soft shadow-brut-xs">
        <span aria-hidden="true" className="relative flex size-2.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-400 opacity-60" />
          <span className="relative size-2.5 rounded-full bg-brand-500" />
        </span>
        {label}…
      </span>
    </div>
  );
}
