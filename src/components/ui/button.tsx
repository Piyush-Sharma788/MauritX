import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "inverse" | "danger" | "danger-solid";
type Size = "md" | "lg";

const base =
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold tracking-[-0.01em] transition duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-3 disabled:pointer-events-none disabled:opacity-60";

const variants: Record<Variant, string> = {
  primary:
    "bg-brand-500 text-white shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_10px_24px_-10px_rgb(210_40_63/0.7)] hover:bg-brand-600 active:translate-y-px",
  secondary: "bg-surface text-ink ring-1 ring-line-strong hover:bg-paper-deep hover:ring-ink/20 active:translate-y-px",
  ghost: "text-ink-soft hover:bg-ink/5 hover:text-ink",
  inverse: "bg-white text-ink hover:bg-brand-50 active:translate-y-px",
  danger: "bg-surface text-danger-600 ring-1 ring-danger-600/30 hover:bg-danger-50 active:translate-y-px",
  "danger-solid": "bg-danger-600 text-white hover:bg-danger-600/90 active:translate-y-px",
};

const sizes: Record<Size, string> = {
  md: "h-11 px-5 text-[0.95rem]",
  lg: "h-13 px-7 text-base",
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
