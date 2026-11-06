import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "inverse" | "danger" | "danger-solid";
type Size = "md" | "lg";

/*
 * Minimal buttons: primary is solid medical red; secondary is white with a
 * hairline border; ghost is text-only for low emphasis. All share one height
 * scale (44/52px touch targets), soft elevation and a subtle press.
 */
const base =
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold tracking-[-0.01em] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "brut-press border border-brand-600 bg-brand-500 text-white hover:bg-brand-600",
  secondary: "brut-press border border-line-strong bg-surface text-ink hover:bg-signal-50",
  ghost: "border border-transparent text-ink-soft transition-colors duration-150 hover:bg-signal-100 hover:text-ink",
  inverse: "brut-press border border-white/20 bg-white text-ink hover:bg-signal-100",
  danger: "brut-press border border-brand-200 bg-surface text-brand-600 hover:border-brand-300 hover:bg-brand-50",
  "danger-solid": "brut-press border border-brand-700 bg-brand-600 text-white hover:bg-brand-700",
};

const sizes: Record<Size, string> = {
  md: "min-h-11 px-4.5 text-[0.95rem]",
  lg: "min-h-13 px-6 text-base",
};

export function buttonClasses({ variant = "primary", size = "md", className = "" }: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}) {
  return `${base} ${variants[variant]} ${sizes[size]} ${className}`;
}

interface CommonProps {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export function Button({ variant, size, className, ...props }: CommonProps & ComponentProps<"button">) {
  return <button className={buttonClasses({ variant, size, className })} {...props} />;
}

export function ButtonLink({ variant, size, className, ...props }: CommonProps & ComponentProps<typeof Link>) {
  return <Link className={buttonClasses({ variant, size, className })} {...props} />;
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
