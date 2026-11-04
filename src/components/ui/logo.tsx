import Link from "next/link";

/** MarutiX mark: a drop whose highlight forms a pulse, set in a soft crimson tile. */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="mx-tile" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e3384f" />
          <stop offset="1" stopColor="#94162a" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#mx-tile)" />
      <path
        d="M20 8.5c4.6 5.5 9 11.2 9 15.6a9 9 0 0 1-18 0c0-4.4 4.4-10.1 9-15.6Z"
        fill="#fff"
      />
      <path
        d="M14.2 24.4h3.1l1.6-3.3 2.3 6 1.7-2.7h3"
        fill="none"
        stroke="#d2283f"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ href = "/", className = "" }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={`group inline-flex items-center gap-2.5 rounded-xl ${className}`} aria-label="MarutiX home">
      <LogoMark className="size-9 transition-transform duration-300 group-hover:-rotate-6" />
      <span className="font-display text-[1.35rem] font-bold tracking-[-0.03em] text-ink">
        Maruti<span className="text-brand-500">X</span>
      </span>
    </Link>
  );
}
