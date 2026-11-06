import Link from "next/link";

/** MarutiX mark: a white drop with a pulse line on a medical-red tile. */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="10" fill="#d92d20" />
      <path d="M20 8c4.3 5.1 8.4 10.4 8.4 14.5a8.4 8.4 0 0 1-16.8 0c0-4.1 4.1-9.4 8.4-14.5Z" fill="#fff" />
      <path d="M14.7 22.9h2.9l1.5-3.1 2.2 5.6 1.6-2.5h2.8" fill="none" stroke="#d92d20" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ href = "/", className = "" }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={`group inline-flex min-h-11 items-center gap-2.5 rounded-lg ${className}`} aria-label="MarutiX home">
      <LogoMark className="size-8 transition-transform duration-200 group-hover:scale-105" />
      <span className="font-display text-[1.2rem] font-semibold tracking-[-0.03em] text-ink">
        Maruti<span className="text-brand-500">X</span>
      </span>
    </Link>
  );
}
