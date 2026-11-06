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
    <section className="relative overflow-hidden border-b border-line bg-surface">
      <div aria-hidden="true" className="absolute inset-0 bg-grid" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:pb-24 lg:pt-20">
        <div className="min-w-0">
          <div className="animate-rise flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-soft shadow-brut-xs">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-400 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-brand-500" />
              </span>
              Early access · India
            </span>
            <span lang="hi" className="font-deva text-[0.95rem] font-medium text-brand-600">
              हर बूँद मायने रखती है
            </span>
          </div>

          <h1 className="animate-rise mt-6 text-balance font-display text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.035em] text-ink [animation-delay:60ms] sm:text-6xl lg:text-[4.1rem]">
            Every Drop Matters.{" "}
            <span className="block text-brand-500">Every Life Counts.</span>
          </h1>

          <p className="animate-rise mt-6 max-w-xl text-lg leading-relaxed text-ink-soft [animation-delay:120ms]">
            MarutiX helps families facing a blood emergency reach nearby voluntary donors and verified blood centres
            over the web and WhatsApp. It&apos;s fast when it matters and private by design, and the medical decisions stay
            with the professionals.
          </p>

          <div className="animate-rise mt-8 flex flex-col gap-3 [animation-delay:180ms] sm:flex-row">
            <ButtonLink href="/request" size="lg" className="group">
              Request Blood
              <ArrowRightIcon className="size-5 transition-transform group-hover:translate-x-0.5" />
            </ButtonLink>
            <BecomeDonorButton size="lg" variant="secondary">
              Become a Donor
            </BecomeDonorButton>
          </div>

          <div className="animate-rise mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm [animation-delay:220ms]">
            <a
              href="tel:112"
              className="inline-flex min-h-10 items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3.5 font-semibold text-brand-700 transition-colors hover:border-brand-300 hover:bg-brand-100"
            >
              <PhoneIcon className="size-4" />
              Life at risk? Call 112
            </a>
            <a href="/get-help" className="inline-flex min-h-10 items-center gap-1.5 font-medium text-ink-soft underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-muted">
              What to do right now
              <ArrowRightIcon className="size-4" />
            </a>
          </div>

          <ul className="animate-rise mt-10 grid gap-3 border-t border-line pt-6 text-sm [animation-delay:260ms] sm:grid-cols-3">
            {HERO_TRUST.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-start gap-2.5 leading-snug text-ink-soft">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <Icon className="size-4" />
                </span>
                <span className="pt-1">{label}</span>
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
      <div className="relative aspect-[4/5] overflow-hidden rounded-2xl border border-line bg-surface shadow-brut-xl sm:aspect-square">
        {/* Window chrome */}
        <div aria-hidden="true" className="absolute inset-x-0 top-0 flex h-10 items-center gap-1.5 border-b border-line bg-paper px-4">
          <span className="size-2.5 rounded-full bg-brand-300" />
          <span className="size-2.5 rounded-full bg-warning-200" />
          <span className="size-2.5 rounded-full bg-mint-300" />
          <span className="ml-auto text-xs font-medium text-ink-muted">Coordination</span>
        </div>

        {/* Rings */}
        <div aria-hidden="true" className="absolute inset-0 top-10 flex items-center justify-center">
          {[82, 60, 38].map((size) => (
            <div key={size} className="absolute aspect-square rounded-full border border-dashed border-line-strong" style={{ width: `${size}%` }} />
          ))}
          <div className="animate-pulse-ring absolute aspect-square w-[30%] rounded-full bg-brand-500/15" />
          <div className="animate-pulse-ring absolute aspect-square w-[30%] rounded-full bg-brand-500/10 [animation-delay:1s]" />
        </div>

        {/* Connectors */}
        <svg aria-hidden="true" className="absolute inset-0 top-10 hidden size-full sm:block" viewBox="0 0 100 100" preserveAspectRatio="none">
          <g stroke="#d0d5dd" strokeWidth="0.6" strokeDasharray="1.6 1.6" fill="none">
            <path d="M50 46 L24 18" />
            <path d="M50 46 L80 33" />
            <path d="M50 46 L34 76" />
          </g>
        </svg>
        <svg aria-hidden="true" className="absolute inset-0 top-10 size-full sm:hidden" viewBox="0 0 100 100" preserveAspectRatio="none">
          <g stroke="#d0d5dd" strokeWidth="0.6" strokeDasharray="1.6 1.6" fill="none">
            <path d="M50 48 L28 14" />
            <path d="M50 48 L76 70" />
            <path d="M50 48 L28 86" />
          </g>
        </svg>

        {/* Centre */}
        <div className="absolute left-1/2 top-[54%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          <LogoMark className="size-16 drop-shadow-md sm:size-[4.5rem]" />
          <span className="mt-2 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-ink-soft shadow-brut-xs">Request</span>
        </div>

        <Node className="left-[5%] top-[16%] sm:top-[17%]" icon={HandshakeIcon} title="Opted-in donors" body="Nearby, available, alerted in small waves" />
        <Node className="right-[4%] top-[66%] sm:top-[36%]" icon={BuildingIcon} title="Verified blood centres" body="Reviewed before access" tone="mint" />
        <Node className="bottom-[5%] left-[6%] sm:bottom-[7%] sm:left-[10%]" icon={StethoscopeIcon} title="Treating hospital" body="Makes every clinical call" tone="signal" />

        <div className="absolute bottom-[14%] right-[4%] hidden max-w-[10.5rem] rounded-xl border border-mint-300 bg-mint-50 p-2.5 shadow-brut-sm sm:block">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-mint-800">
            <CheckIcon className="size-3.5" strokeWidth={2.75} />
            Consent first
          </div>
          <p className="mt-1 text-[0.72rem] leading-snug text-ink-soft">A donor&apos;s number is shared only after they say yes.</p>
        </div>
      </div>
      <figcaption className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-muted">
        <ShieldIcon className="size-3.5" />
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
  const iconTone = { brand: "bg-brand-50 text-brand-600", mint: "bg-mint-50 text-mint-800", signal: "bg-signal-100 text-signal-800" }[tone];
  return (
    <div className={`absolute flex max-w-[11.5rem] items-center gap-2.5 rounded-xl border border-line bg-surface p-2 shadow-brut-lg sm:items-start sm:p-2.5 ${className}`}>
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${iconTone}`}>
        <Icon className="size-4" />
      </span>
      <span>
        <span className="block text-[0.78rem] font-semibold leading-tight text-ink">{title}</span>
        <span className="mt-0.5 hidden text-[0.7rem] leading-snug text-ink-muted sm:block">{body}</span>
      </span>
    </div>
  );
}
