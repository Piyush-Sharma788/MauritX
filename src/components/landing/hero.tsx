import { BecomeDonorButton } from "@/components/donor/become-donor-button";
import { ButtonLink } from "@/components/ui/button";
import {
  ArrowRightIcon,
  BuildingIcon,
  ChatIcon,
  CheckIcon,
  HandshakeIcon,
  LockIcon,
  ShieldIcon,
  StethoscopeIcon,
} from "@/components/ui/icons";
import { LogoMark } from "@/components/ui/logo";

const HERO_TRUST = [
  { icon: ChatIcon, label: "WhatsApp alerts only if you opt in" },
  { icon: HandshakeIcon, label: "Consent before any contact is shared" },
  { icon: LockIcon, label: "Your data is never sold" },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Soft background wash */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -top-48 left-1/2 h-[42rem] w-[42rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(210_40_63/0.12),transparent)] lg:left-[68%]" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-line-strong to-transparent" />
      </div>

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pb-20 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:pb-28 lg:pt-20">
        <div>
          <p className="animate-rise inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-full border border-brand-100 bg-surface/80 py-1.5 pl-2 pr-4 text-[0.8rem] font-medium text-ink-soft shadow-soft">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-0.5 text-brand-700">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-400 opacity-60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-brand-500" />
              </span>
              Early access
            </span>
            <span lang="hi" className="font-deva text-ink">
              हर बूँद मायने रखती है
            </span>
          </p>

          <h1 className="animate-rise mt-6 font-display text-[2.6rem] font-bold leading-[1.02] tracking-[-0.045em] text-ink [animation-delay:80ms] sm:text-6xl lg:text-[4.35rem]">
            Every Drop Matters.
            <span className="block text-brand-500">Every Life Counts.</span>
          </h1>

          <p className="animate-rise mt-6 max-w-xl text-lg leading-relaxed text-ink-soft [animation-delay:160ms] sm:text-[1.2rem]">
            MarutiX helps families facing a blood emergency reach nearby voluntary donors and verified blood centres
            over the web and WhatsApp. It&apos;s fast when it matters and private by design, and the medical decisions stay
            with the professionals.
          </p>

          <div className="animate-rise mt-9 flex flex-col gap-3 [animation-delay:240ms] sm:flex-row">
            <ButtonLink href="/request" size="lg" className="group">
              Request Blood
              <ArrowRightIcon className="size-4.5 transition-transform group-hover:translate-x-0.5" />
            </ButtonLink>
            <BecomeDonorButton size="lg" variant="secondary">
              Become a Donor
            </BecomeDonorButton>
          </div>

          <p className="animate-rise mt-4 text-sm text-ink-soft [animation-delay:280ms]">
            Life at risk? Call <a href="tel:112" className="font-semibold text-ink underline underline-offset-2">112</a> ·{" "}
            <a href="/get-help" className="font-semibold text-brand-600 hover:text-brand-700">What to do right now</a>
          </p>

          <ul className="animate-rise mt-7 grid gap-2.5 text-sm text-ink-soft [animation-delay:320ms] sm:grid-cols-3 sm:gap-4">
            {HERO_TRUST.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-2">
                <Icon className="size-4.5 shrink-0 text-brand-500" />
                {label}
              </li>
            ))}
          </ul>
        </div>

        <CoordinationVisual />
      </div>
    </section>
  );
}

/** Illustration of how a request is coordinated. Shows no real or simulated data. */
function CoordinationVisual() {
  return (
    <figure className="animate-rise relative mx-auto w-full max-w-[30rem] [animation-delay:200ms]">
      <div className="relative aspect-[4/5] overflow-hidden rounded-[2rem] sm:aspect-square border border-line bg-gradient-to-br from-surface via-paper to-brand-50 shadow-lift">
        <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(rgb(29_20_24/0.06)_1px,transparent_1px)] [background-size:18px_18px]" />

        {/* Rings */}
        <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          {[78, 56, 34].map((size) => (
            <div key={size} className="absolute aspect-square rounded-full border border-brand-200/70" style={{ width: `${size}%` }} />
          ))}
          <div className="animate-pulse-ring absolute aspect-square w-[34%] rounded-full bg-brand-400/25" />
          <div className="animate-pulse-ring absolute aspect-square w-[34%] rounded-full bg-brand-400/20 [animation-delay:1.8s]" />
        </div>

        {/* Connectors */}
        <svg aria-hidden="true" className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <g stroke="rgb(210 40 63 / 0.35)" strokeWidth="0.35" strokeDasharray="1.2 1.4" fill="none">
            <path d="M50 50 L24 23" />
            <path d="M50 50 L80 40" />
            <path d="M50 50 L36 80" />
          </g>
        </svg>

        {/* Centre */}
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          <div className="rounded-[1.4rem] bg-surface p-2 shadow-lift">
            <LogoMark className="size-14 sm:size-16" />
          </div>
          <span className="mt-2.5 rounded-full bg-ink px-3 py-1 text-[0.7rem] font-semibold tracking-wide text-white">
            Request
          </span>
        </div>

        <Node className="left-[5%] top-[5%] sm:top-[12%]" icon={HandshakeIcon} title="Opted-in donors" body="Nearby, available, alerted in small waves" />
        <Node className="right-[4%] top-[22%] sm:top-[33%]" icon={BuildingIcon} title="Verified blood centres" body="Reviewed before access" />
        <Node className="bottom-[5%] left-[8%] sm:bottom-[8%] sm:left-[12%]" icon={StethoscopeIcon} title="Treating hospital" body="Makes every clinical call" />

        <div className="animate-float absolute bottom-[24%] right-[5%] hidden max-w-[11rem] rounded-2xl border border-success-600/15 bg-surface/95 p-3 shadow-soft backdrop-blur sm:block">
          <div className="flex items-center gap-2 text-[0.72rem] font-semibold text-success-600">
            <span className="flex size-5 items-center justify-center rounded-full bg-success-50">
              <CheckIcon className="size-3.5" />
            </span>
            Consent first
          </div>
          <p className="mt-1.5 text-[0.72rem] leading-snug text-ink-soft">A donor&apos;s number is shared only after they say yes.</p>
        </div>
      </div>
      <figcaption className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-muted">
        <ShieldIcon className="size-4" />
        Illustration of how MarutiX coordinates a request
      </figcaption>
    </figure>
  );
}

function Node({
  className,
  icon: Icon,
  title,
  body,
}: {
  className: string;
  icon: typeof HandshakeIcon;
  title: string;
  body: string;
}) {
  return (
    <div className={`absolute flex max-w-[11.5rem] items-center gap-2.5 sm:items-start rounded-2xl border border-line bg-surface/95 p-2.5 shadow-soft backdrop-blur sm:p-3 ${className}`}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
        <Icon className="size-4.5" />
      </span>
      <span>
        <span className="block text-[0.78rem] font-semibold leading-tight text-ink">{title}</span>
        <span className="mt-0.5 hidden text-[0.7rem] leading-snug text-ink-muted sm:block">{body}</span>
      </span>
    </div>
  );
}
