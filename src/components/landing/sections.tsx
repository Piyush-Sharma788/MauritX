import Link from "next/link";
import { BecomeDonorButton } from "@/components/donor/become-donor-button";
import { ButtonLink } from "@/components/ui/button";
import {
  ArrowRightIcon,
  BuildingIcon,
  ChatIcon,
  CheckIcon,
  HandshakeIcon,
  LockIcon,
  MapPinIcon,
  StethoscopeIcon,
  XIcon,
} from "@/components/ui/icons";

function SectionHeading({ eyebrow, title, intro, tone = "light" }: {
  eyebrow: string;
  title: string;
  intro?: string;
  tone?: "light" | "dark";
}) {
  const dark = tone === "dark";
  return (
    <div className="max-w-2xl">
      <p className={`eyebrow inline-flex items-center gap-2 rounded-sm border-2 px-2 py-1 ${dark ? "border-signal-300 text-signal-300" : "border-ink bg-surface text-ink"}`}>
        <span aria-hidden="true" className={`size-2 ${dark ? "bg-signal-300" : "bg-brand-500"}`} />
        {eyebrow}
      </p>
      <h2 className={`mt-5 text-balance font-display text-[2.1rem] font-extrabold leading-[1.02] tracking-[-0.045em] sm:text-[3.1rem] ${dark ? "text-white" : "text-ink"}`}>
        {title}
      </h2>
      {intro && <p className={`mt-5 text-lg leading-relaxed ${dark ? "text-white/80" : "text-ink-soft"}`}>{intro}</p>}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * How it works
 * ------------------------------------------------------------------------ */

const FAMILY_STEPS = [
  {
    title: "Tell us what the hospital needs",
    body: "Blood group (or “not known yet”), component, units and hospital. About two minutes, no account needed.",
  },
  {
    title: "We verify it with the hospital",
    body: "The MarutiX team confirms the request before it's marked verified. Nothing is verified automatically.",
  },
  {
    title: "Track it with a private link",
    body: "See every status update, and share a view-only link with family. The blood centre handles screening and compatibility.",
  },
];

const DONOR_STEPS = [
  { title: "Message us on WhatsApp", body: "Tap Become a Donor and send REGISTER. No forms, no passwords. We use the number you message from." },
  {
    title: "Share only what's needed",
    body: "Blood group if you know it, your approximate area and availability. Never your medical history.",
  },
  {
    title: "Stay in control",
    body: "Reply UPDATE, PAUSE or STOP in the chat, or sign in on the website to manage your profile.",
  },
];

const ROLLOUT = [
  { label: "Donor registration on WhatsApp", state: "Live now", live: true },
  { label: "Emergency requests & verification", state: "Live now", live: true },
  { label: "Donor alerts & blood-centre network", state: "Next", live: false },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="How it works"
            title="One calm, guided path when every minute counts."
            intro="MarutiX handles the coordination: who to reach, in what order and with whose consent. That leaves families and donors free to focus on what matters."
          />
          <div className="w-full overflow-hidden rounded-md border-2 border-ink bg-surface shadow-brut lg:max-w-sm">
            <p className="eyebrow border-b-2 border-ink bg-ink px-4 py-2 text-white">Rolling out in phases</p>
            <ol className="divide-y-2 divide-ink/10 px-4 py-1">
              {ROLLOUT.map((item, i) => (
                <li key={item.label} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="flex items-center gap-2.5 font-medium text-ink">
                    <span
                      className={`flex size-6 shrink-0 items-center justify-center rounded-sm border-2 border-ink font-mono text-[0.7rem] font-bold ${
                        item.live ? "bg-mint-400 text-ink" : "bg-paper-deep text-ink"
                      }`}
                    >
                      {item.live ? <CheckIcon className="size-3.5" strokeWidth={3} /> : i + 1}
                    </span>
                    {item.label}
                  </span>
                  <span className={`shrink-0 rounded-sm border-2 border-ink px-1.5 font-mono text-[0.62rem] font-bold uppercase tracking-[0.08em] ${item.live ? "bg-mint-100 text-mint-800" : "bg-paper-deep text-ink-soft"}`}>{item.state}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-2 lg:gap-8">
          <StepCard label="For families & caregivers" steps={FAMILY_STEPS} accent />
          <StepCard label="For voluntary donors" steps={DONOR_STEPS} />
        </div>
      </div>
    </section>
  );
}

function StepCard({ label, steps, accent = false }: { label: string; steps: { title: string; body: string }[]; accent?: boolean }) {
  return (
    <article className={`brut-lift relative overflow-hidden rounded-md border-2 border-ink shadow-brut ${accent ? "bg-brand-50" : "bg-surface"}`}>
      <h3 className={`flex items-center justify-between border-b-2 border-ink px-6 py-3 font-display text-lg font-extrabold tracking-[-0.02em] sm:px-8 ${accent ? "bg-brand-500 text-white" : "bg-ink text-white"}`}>
        {label}
        <span aria-hidden="true" className="font-mono text-xs font-bold tracking-[0.12em] opacity-80">{String(steps.length).padStart(2, "0")} STEPS</span>
      </h3>
      <ol className="space-y-6 p-6 sm:p-8">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-4">
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-sm border-2 border-ink font-mono text-sm font-bold shadow-brut-xs ${
                accent ? "bg-signal-300 text-ink" : "bg-mint-300 text-ink"
              }`}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <p className="font-bold text-ink">{step.title}</p>
              <p className="mt-1 text-[0.95rem] leading-relaxed text-ink-soft">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}

/* --------------------------------------------------------------------------
 * Trust & safety
 * ------------------------------------------------------------------------ */

const COMMITMENTS = [
  {
    icon: HandshakeIcon,
    title: "Consent before contact",
    body: "A donor's phone number is never shown to a requester until that donor explicitly agrees.",
  },
  {
    icon: StethoscopeIcon,
    title: "Clinicians decide",
    body: "Eligibility, screening and compatibility are decided by a licensed blood centre, never by an app or an algorithm.",
  },
  {
    icon: ChatIcon,
    title: "WhatsApp, used responsibly",
    body: "Sign-in codes use Meta's official WhatsApp Business Platform. Pilot alerts go only to people who opted in, are rate-limited, and stop the moment you reply STOP. No scraped contacts, ever.",
  },
  {
    icon: LockIcon,
    title: "Minimal, encrypted data",
    body: "Phone numbers are encrypted at rest and one-time codes are stored only as one-way hashes. No Aadhaar, no medical records.",
  },
  {
    icon: MapPinIcon,
    title: "Location stays approximate",
    body: "Donor locations are never shown on a public map. You can always type a locality instead of sharing GPS.",
  },
  {
    icon: BuildingIcon,
    title: "Verified institutions",
    body: "Blood banks and hospitals are reviewed before they get access, and stock information always shows its source and age.",
  },
];

export function TrustSafety() {
  return (
    <section id="safety" className="on-dark scroll-mt-20 border-y-2 border-ink bg-ink py-20 text-white sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          tone="dark"
          eyebrow="Trust & safety"
          title="Built for trust, not just speed."
          intro="An emergency is exactly when people need to know their information is safe and that the decisions stay with professionals. These commitments shape every feature we ship."
        />
        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
          {COMMITMENTS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="group rounded-md border-2 border-white/90 bg-ink p-6 shadow-[6px_6px_0_0_var(--color-brand-500)] transition-transform duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 sm:p-7">
              <div className="flex items-center justify-between">
                <span className="flex size-12 items-center justify-center rounded-sm border-2 border-white bg-signal-300 text-ink transition-transform duration-200 group-hover:-rotate-6">
                  <Icon className="size-6" />
                </span>
                <span aria-hidden="true" className="font-mono text-xs font-bold text-white/40">{String(i + 1).padStart(2, "0")}</span>
              </div>
              <h3 className="mt-5 font-display text-xl font-extrabold tracking-[-0.02em] text-white">{title}</h3>
              <p className="mt-2 text-[0.95rem] leading-relaxed text-white/80">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Donors
 * ------------------------------------------------------------------------ */

const WE_ASK = [
  "Nothing for your number: we use the WhatsApp number you message from",
  "Your blood group, or “not sure”",
  "Your approximate area, never your exact address",
  "When you're available to be contacted",
];

const WE_NEVER_ASK = [
  "Aadhaar or identity documents",
  "Diagnoses or medical history",
  "Any payment, ever",
  "To share your number without your OK",
];

export function DonorBand() {
  return (
    <section id="donors" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="relative grid gap-10 rounded-md border-[3px] border-ink bg-surface p-6 shadow-brut-xl sm:p-10 lg:grid-cols-[1fr_1.1fr] lg:gap-14 lg:p-14">
          <span aria-hidden="true" className="absolute -top-4 right-6 rotate-3 rounded-sm border-2 border-ink bg-mint-300 px-3 py-1 font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink shadow-brut-xs sm:right-10">~2 min on WhatsApp</span>
          <div className="flex flex-col justify-center">
            <SectionHeading
              eyebrow="For donors"
              title="Register once. Help when you can."
              intro="Registering takes about two minutes in a WhatsApp chat. Being a donor doesn't mean being on call: you decide when you're available, and you'll only hear about requests near you."
            />
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <BecomeDonorButton size="lg" className="group">
                Become a Donor
                <ArrowRightIcon className="size-4.5 transition-transform group-hover:translate-x-0.5" />
              </BecomeDonorButton>
              <ButtonLink href="/donate" size="lg" variant="ghost" className="whitespace-normal text-center">
                On a computer? Scan a QR code
              </ButtonLink>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <ChecklistCard title="What we'll ask" items={WE_ASK} positive />
            <ChecklistCard title="What we'll never ask" items={WE_NEVER_ASK} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ChecklistCard({ title, items, positive = false }: { title: string; items: string[]; positive?: boolean }) {
  return (
    <div className={`rounded-md border-2 border-ink p-5 sm:p-6 ${positive ? "bg-mint-50" : "bg-paper-deep"}`}>
      <h3 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{title}</h3>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[0.93rem] leading-snug text-ink">
            <span
              className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-sm border-2 border-ink ${
                positive ? "bg-mint-400 text-ink" : "bg-brand-500 text-white"
              }`}
            >
              {positive ? <CheckIcon className="size-3" strokeWidth={3.5} /> : <XIcon className="size-3" strokeWidth={3.5} />}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * FAQ
 * ------------------------------------------------------------------------ */

const FAQS = [
  {
    q: "Is MarutiX a blood bank?",
    a: "No. MarutiX coordinates communication between families, voluntary donors and verified institutions. It does not collect, test, store, transport or certify blood.",
  },
  {
    q: "If I reply “Interested”, does that mean I'm eligible to donate?",
    a: "No. A response on MarutiX is not medical clearance. The blood centre checks identity, health, haemoglobin and compatibility before any donation.",
  },
  {
    q: "Who can see my phone number?",
    a: "Not requesters, and not the public. Your number is encrypted at rest, and it's shared with a specific requester only if you choose to share it for that request.",
  },
  {
    q: "Why WhatsApp?",
    a: "Most people in India already use it every day. Sign-in codes are sent through Meta's official WhatsApp Business Platform. During our pilot, donor alerts come from a MarutiX number linked through WhatsApp Web, and only to people who opted in. The MarutiX web app remains the place for full details and controls.",
  },
  {
    q: "Are there any payments?",
    a: "No. Families aren't charged, donors aren't paid, and donor data is never sold.",
  },
  {
    q: "What can I do on MarutiX today?",
    a: "We're launching in phases. Today you can post an emergency blood request (our team verifies it with the hospital and you can track it with a private link) and register as a voluntary donor on WhatsApp. Alerts to nearby donors come next. If someone needs blood right now, also follow the steps on our Get Help page.",
    link: { href: "/get-help", label: "Go to Get Help" },
  },
];

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 border-t-2 border-ink bg-paper-deep py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeading eyebrow="FAQ" title="Questions people ask us." intro="Can't find what you need? In an emergency, always speak to the treating hospital first." />
        <div className="space-y-3">
          {FAQS.map((item) => (
            <details key={item.q} className="group rounded-md border-2 border-ink bg-surface shadow-brut-sm transition-shadow open:shadow-brut [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-md px-5 py-3 font-bold text-ink transition-colors hover:bg-signal-50 group-open:border-b-2 group-open:border-ink sm:px-6">
                {item.q}
                <span className="flex size-8 shrink-0 items-center justify-center rounded-sm border-2 border-ink bg-signal-300 text-ink transition-transform duration-200 group-open:rotate-45 group-open:bg-brand-500 group-open:text-white">
                  <XIcon className="size-4 rotate-45" strokeWidth={3} />
                </span>
              </summary>
              <div className="px-5 pb-5 pt-4 text-[0.95rem] leading-relaxed text-ink-soft sm:px-6">
                <p>{item.a}</p>
                {item.link && (
                  <Link href={item.link.href} className="mt-3 inline-flex min-h-11 items-center gap-1.5 font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-4 hover:decoration-4">
                    {item.link.label}
                    <ArrowRightIcon className="size-4" />
                  </Link>
                )}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
