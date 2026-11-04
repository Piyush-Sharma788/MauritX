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
      <p className={`text-xs font-semibold uppercase tracking-[0.16em] ${dark ? "text-brand-200" : "text-brand-600"}`}>{eyebrow}</p>
      <h2 className={`mt-3 font-display text-3xl font-bold tracking-[-0.035em] sm:text-[2.6rem] sm:leading-[1.08] ${dark ? "text-white" : "text-ink"}`}>
        {title}
      </h2>
      {intro && <p className={`mt-4 text-lg leading-relaxed ${dark ? "text-white/70" : "text-ink-soft"}`}>{intro}</p>}
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
          <div className="w-full rounded-2xl border border-line bg-surface p-5 shadow-soft lg:max-w-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">Rolling out in phases</p>
            <ol className="mt-3 space-y-2.5">
              {ROLLOUT.map((item, i) => (
                <li key={item.label} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2.5 text-ink">
                    <span
                      className={`flex size-5 items-center justify-center rounded-full text-[0.65rem] font-bold ${
                        item.live ? "bg-success-600 text-white" : "bg-paper-deep text-ink-muted"
                      }`}
                    >
                      {item.live ? <CheckIcon className="size-3" /> : i + 1}
                    </span>
                    {item.label}
                  </span>
                  <span className={`shrink-0 text-xs font-medium ${item.live ? "text-success-600" : "text-ink-muted"}`}>{item.state}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          <StepCard label="For families & caregivers" steps={FAMILY_STEPS} accent />
          <StepCard label="For voluntary donors" steps={DONOR_STEPS} />
        </div>
      </div>
    </section>
  );
}

function StepCard({ label, steps, accent = false }: { label: string; steps: { title: string; body: string }[]; accent?: boolean }) {
  return (
    <article
      className={`relative overflow-hidden rounded-[var(--radius-card)] border p-6 sm:p-8 ${
        accent ? "border-brand-100 bg-gradient-to-br from-brand-50 via-surface to-surface" : "border-line bg-surface"
      }`}
    >
      <h3 className="text-sm font-semibold text-ink">{label}</h3>
      <ol className="mt-6 space-y-6">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-4">
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-full font-display text-sm font-bold ${
                accent ? "bg-brand-500 text-white" : "bg-ink text-white"
              }`}
            >
              {i + 1}
            </span>
            <div>
              <p className="font-semibold text-ink">{step.title}</p>
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
    <section id="safety" className="scroll-mt-20 bg-ink py-20 text-white sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          tone="dark"
          eyebrow="Trust & safety"
          title="Built for trust, not just speed."
          intro="An emergency is exactly when people need to know their information is safe and that the decisions stay with professionals. These commitments shape every feature we ship."
        />
        <ul className="mt-14 grid gap-px overflow-hidden rounded-[var(--radius-card)] bg-white/10 sm:grid-cols-2 lg:grid-cols-3">
          {COMMITMENTS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="bg-ink p-6 transition-colors hover:bg-white/[0.03] sm:p-8">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-200 ring-1 ring-brand-400/25">
                <Icon className="size-5" />
              </span>
              <h3 className="mt-5 font-semibold text-white">{title}</h3>
              <p className="mt-2 text-[0.95rem] leading-relaxed text-white/65">{body}</p>
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
        <div className="grid gap-10 overflow-hidden rounded-[2rem] border border-line bg-surface p-6 shadow-soft sm:p-10 lg:grid-cols-[1fr_1.1fr] lg:gap-14 lg:p-14">
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
              <ButtonLink href="/donate" size="lg" variant="ghost">
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
    <div className={`rounded-2xl p-5 sm:p-6 ${positive ? "bg-success-50" : "bg-paper-deep"}`}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[0.93rem] leading-snug text-ink-soft">
            <span
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${
                positive ? "bg-success-600 text-white" : "bg-ink/10 text-ink-soft"
              }`}
            >
              {positive ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
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
    <section id="faq" className="scroll-mt-20 border-t border-line py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeading eyebrow="FAQ" title="Questions people ask us." intro="Can't find what you need? In an emergency, always speak to the treating hospital first." />
        <div className="divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface">
          {FAQS.map((item) => (
            <details key={item.q} className="group px-5 py-1 sm:px-6 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg py-4 font-semibold text-ink">
                {item.q}
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-deep text-ink-soft transition-transform duration-200 group-open:rotate-45">
                  <XIcon className="size-3.5 rotate-45" />
                </span>
              </summary>
              <div className="pb-5 pr-8 text-[0.95rem] leading-relaxed text-ink-soft">
                <p>{item.a}</p>
                {item.link && (
                  <Link href={item.link.href} className="mt-3 inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:text-brand-700">
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
