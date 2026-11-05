import { BecomeDonorButton } from "@/components/donor/become-donor-button";
import { ButtonLink } from "@/components/ui/button";
import {
  ArrowRightIcon,
  BuildingIcon,
  ChatIcon,
  CheckIcon,
  HandshakeIcon,
  LockIcon,
  PhoneIcon,
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
    <section className="relative overflow-hidden border-b-2 border-ink bg-grid">
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pb-16 pt-10 sm:px-6 sm:pt-14 lg:grid-cols-[1.08fr_0.92fr] lg:gap-12 lg:pb-24 lg:pt-20">
        <div className="min-w-0">
          <div className="animate-rise flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-2 rounded-sm border-2 border-ink bg-surface px-2.5 py-1 font-mono text-[0.7rem] font-bold uppercase tracking-[0.12em] text-ink shadow-brut-xs">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-400 opacity-70" />
                <span className="relative inline-flex size-2 rounded-full bg-brand-500" />
              </span>
              Early access · India
            </span>
            <span
              lang="hi"
              className="inline-block -rotate-2 rounded-sm border-2 border-ink bg-signal-300 px-2.5 py-0.5 font-deva text-[0.95rem] font-bold text-ink shadow-brut-xs"
            >
              हर बूँद मायने रखती है
            </span>
          </div>

          <h1 className="animate-rise mt-7 text-balance font-display text-[2.85rem] font-extrabold leading-[0.95] tracking-[-0.055em] text-ink [animation-delay:60ms] sm:text-7xl lg:text-[4.6rem]">
            Every Drop Matters.{" "}
            <span className="mt-1 block text-brand-500">
              Every Life <span className="relative inline-block">Counts.<svg aria-hidden="true" viewBox="0 0 200 14" preserveAspectRatio="none" className="absolute -bottom-2 left-0 h-3 w-full text-ink sm:-bottom-3 sm:h-4"><path d="M2 9 Q 50 2 100 8 T 198 6" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="square" /></svg></span>
            </span>
          </h1>

          <p className="animate-rise mt-8 max-w-xl text-lg leading-relaxed text-ink-soft [animation-delay:120ms] sm:text-[1.2rem]">
            MarutiX helps families facing a blood emergency reach nearby voluntary donors and verified blood centres
            over the web and WhatsApp. It&apos;s fast when it matters and private by design, and the medical decisions stay
            with the professionals.
          </p>

          <div className="animate-rise mt-9 flex flex-col gap-4 [animation-delay:180ms] sm:flex-row">
            <ButtonLink href="/request" size="lg" className="group">
              Request Blood
              <ArrowRightIcon className="size-5 transition-transform group-hover:translate-x-1" />
            </ButtonLink>
            <BecomeDonorButton size="lg" variant="secondary">
              Become a Donor
            </BecomeDonorButton>
          </div>

          <div className="animate-rise mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm [animation-delay:220ms]">
            <a
              href="tel:112"
              className="inline-flex min-h-11 items-center gap-2 rounded-md border-2 border-ink bg-ink px-3.5 font-bold text-white transition-colors hover:bg-brand-600"
            >
              <PhoneIcon className="size-4" />
              Life at risk? Call 112
            </a>
            <a href="/get-help" className="inline-flex min-h-11 items-center gap-1.5 font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-4 hover:decoration-4">
              What to do right now
              <ArrowRightIcon className="size-4" />
            </a>
          </div>

          <ul className="animate-rise mt-9 grid gap-2 text-sm [animation-delay:260ms] sm:grid-cols-3 sm:gap-3">
            {HERO_TRUST.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-2.5 rounded-md border-2 border-ink bg-surface px-3 py-2 font-medium leading-snug text-ink">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-brand-500 text-white">
                  <Icon className="size-4" />
                </span>
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
    <figure className="animate-rise relative mx-auto w-full max-w-[30rem] [animation-delay:160ms]">
      <div className="relative aspect-[4/5] overflow-hidden rounded-md border-[3px] border-ink bg-surface shadow-brut-xl sm:aspect-square">
        <div aria-hidden="true" className="absolute inset-0 bg-dots opacity-60" />

        {/* Window chrome */}
        <div aria-hidden="true" className="absolute inset-x-0 top-0 flex h-9 items-center gap-1.5 border-b-[3px] border-ink bg-signal-300 px-3">
          <span className="size-3 rounded-full border-2 border-ink bg-brand-500" />
          <span className="size-3 rounded-full border-2 border-ink bg-surface" />
          <span className="size-3 rounded-full border-2 border-ink bg-mint-400" />
          <span className="ml-auto font-mono text-[0.65rem] font-bold uppercase tracking-[0.14em] text-ink">coordination</span>
        </div>

        {/* Rings */}
        <div aria-hidden="true" className="absolute inset-0 top-9 flex items-center justify-center">
          {[80, 58, 36].map((size) => (
            <div key={size} className="absolute aspect-square rounded-full border-2 border-dashed border-ink/25" style={{ width: `${size}%` }} />
          ))}
          <div className="animate-pulse-ring absolute aspect-square w-[30%] rounded-full bg-brand-500/25" />
          <div className="animate-pulse-ring absolute aspect-square w-[30%] rounded-full bg-brand-500/20 [animation-delay:1.2s]" />
        </div>

        {/* Connectors */}
        <svg aria-hidden="true" className="absolute inset-0 top-9 hidden size-full sm:block" viewBox="0 0 100 100" preserveAspectRatio="none">
          <g stroke="#1d1418" strokeWidth="0.7" strokeDasharray="2 1.6" fill="none">
            <path d="M50 46 L24 18" />
            <path d="M50 46 L80 33" />
            <path d="M50 46 L34 76" />
          </g>
        </svg>
        <svg aria-hidden="true" className="absolute inset-0 top-9 size-full sm:hidden" viewBox="0 0 100 100" preserveAspectRatio="none">
          <g stroke="#1d1418" strokeWidth="0.7" strokeDasharray="2 1.6" fill="none">
            <path d="M50 48 L28 14" />
            <path d="M50 48 L76 70" />
            <path d="M50 48 L28 86" />
          </g>
        </svg>

        {/* Centre */}
        <div className="absolute left-1/2 top-[54%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          <LogoMark className="size-16 sm:size-20" />
          <span className="mt-2 rounded-sm border-2 border-ink bg-ink px-2.5 py-0.5 font-mono text-[0.68rem] font-bold uppercase tracking-[0.14em] text-white">
            Request
          </span>
        </div>

        <Node className="left-[5%] top-[15%] sm:top-[17%]" icon={HandshakeIcon} title="Opted-in donors" body="Nearby, available, alerted in small waves" />
        <Node className="right-[4%] top-[66%] sm:top-[36%]" icon={BuildingIcon} title="Verified blood centres" body="Reviewed before access" tone="mint" />
        <Node className="bottom-[5%] left-[6%] sm:bottom-[7%] sm:left-[10%]" icon={StethoscopeIcon} title="Treating hospital" body="Makes every clinical call" tone="signal" />

        <div className="animate-wiggle absolute bottom-[14%] right-[4%] hidden max-w-[10.5rem] rounded-sm border-2 border-ink bg-mint-300 p-2.5 shadow-brut-sm [--wiggle-from:3deg] [--wiggle-to:-1deg] sm:block">
          <div className="flex items-center gap-1.5 font-mono text-[0.66rem] font-bold uppercase tracking-[0.1em] text-ink">
            <CheckIcon className="size-3.5" strokeWidth={3} />
            Consent first
          </div>
          <p className="mt-1 text-[0.72rem] font-medium leading-snug text-ink">A donor&apos;s number is shared only after they say yes.</p>
        </div>
      </div>
      <figcaption className="mt-6 flex items-center justify-center gap-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-ink-muted">
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
  tone = "brand",
}: {
  className: string;
  icon: typeof HandshakeIcon;
  title: string;
  body: string;
  tone?: "brand" | "mint" | "signal";
}) {
  const iconTone = { brand: "bg-brand-500 text-white", mint: "bg-mint-400 text-ink", signal: "bg-signal-300 text-ink" }[tone];
  return (
    <div className={`absolute flex max-w-[11.5rem] items-center gap-2.5 rounded-md border-2 border-ink bg-surface p-2 shadow-brut-sm sm:items-start sm:p-2.5 ${className}`}>
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-sm border-2 border-ink ${iconTone}`}>
        <Icon className="size-4" />
      </span>
      <span>
        <span className="block text-[0.78rem] font-bold leading-tight text-ink">{title}</span>
        <span className="mt-0.5 hidden text-[0.7rem] leading-snug text-ink-muted sm:block">{body}</span>
      </span>
    </div>
  );
}
