import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "inverse" | "danger" | "danger-solid";
type Size = "md" | "lg";

/*
 * Neo-brutalist buttons: ink outline, hard shadow, and a physical "press"
 * into the shadow on hover/active (see brut-press in globals.css).
 * Ghost buttons stay flat for low-emphasis actions.
 */
const base =
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-bold tracking-[-0.01em] focus-visible:outline-3 focus-visible:outline-offset-3 disabled:pointer-events-none disabled:opacity-55";

const solid = "border-2 border-ink brut-press";

const variants: Record<Variant, string> = {
  primary: `${solid} bg-brand-500 text-white hover:bg-brand-600`,
  secondary: `${solid} bg-surface text-ink hover:bg-signal-100`,
  ghost: "border-2 border-transparent text-ink-soft transition-colors hover:border-ink hover:bg-surface hover:text-ink active:translate-y-px",
  inverse: `${solid} bg-signal-300 text-ink hover:bg-signal-400`,
  danger: `${solid} bg-surface text-danger-600 hover:bg-danger-50`,
  "danger-solid": `${solid} bg-danger-600 text-white hover:bg-brand-700`,
};

const sizes: Record<Size, string> = {
  md: "min-h-11 px-5 text-[0.95rem]",
  lg: "min-h-13 px-7 text-base",
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
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
    </svg>
  );
}
