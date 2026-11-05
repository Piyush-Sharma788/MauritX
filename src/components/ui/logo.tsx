import Link from "next/link";

/** MarutiX mark: a white drop with a pulse line, in a crimson ink-outlined tile with a hard shadow. */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="4" y="4" width="35" height="35" rx="3" fill="#1d1418" />
      <rect x="1.25" y="1.25" width="34.5" height="34.5" rx="3" fill="#d2283f" stroke="#1d1418" strokeWidth="2.5" />
      <path d="M18.5 7.5c4.3 5.1 8.4 10.4 8.4 14.5a8.4 8.4 0 0 1-16.8 0c0-4.1 4.1-9.4 8.4-14.5Z" fill="#fffdf9" stroke="#1d1418" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13.2 22.4h2.9l1.5-3.1 2.2 5.6 1.6-2.5h2.8" fill="none" stroke="#d2283f" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

export function Logo({ href = "/", className = "" }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={`group inline-flex min-h-11 items-center gap-2.5 rounded-md ${className}`} aria-label="MarutiX home">
      <LogoMark className="size-9 transition-transform duration-200 group-hover:-rotate-6 group-active:rotate-0" />
      <span className="font-display text-[1.4rem] font-extrabold tracking-[-0.05em] text-ink">
        Maruti<span className="text-brand-500">X</span>
      </span>
    </Link>
  );
}
