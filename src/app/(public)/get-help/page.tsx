import type { Metadata } from "next";
import { BecomeDonorButton } from "@/components/donor/become-donor-button";
import { SafetyNotice } from "@/components/landing/safety-notice";
import { ButtonLink } from "@/components/ui/button";
import { ExternalIcon, InfoIcon, PhoneIcon, StethoscopeIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Find blood / get help",
  description: "What to do right now if someone needs blood in India.",
};

const STEPS = [
  {
    icon: StethoscopeIcon,
    title: "Speak to the treating hospital or blood centre first",
    body: "Ask exactly what is needed: blood group, component (whole blood, packed red cells, platelets or plasma) and number of units. They may already be arranging it, and they make every clinical decision.",
  },
  {
    icon: ExternalIcon,
    title: "Check blood-centre stock on e-RaktKosh",
    body: "The Government of India's e-RaktKosh portal lists blood centres and their reported stock. Always call the centre to confirm before travelling.",
    action: { href: "https://eraktkosh.mohfw.gov.in/", label: "Open e-RaktKosh" },
  },
  {
    icon: PhoneIcon,
    title: "If life is at risk, call emergency services",
    body: "Dial 112 for the national emergency response line, or 108 for an ambulance in most states.",
    action: { href: "tel:112", label: "Call 112" },
  },
];

export default function GetHelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">Find blood / get help</p>
      <h1 className="mt-3 font-display text-4xl font-bold tracking-[-0.04em] text-ink sm:text-5xl">
        Someone needs blood. Here&apos;s what to do right now.
      </h1>
      <p className="mt-5 text-lg leading-relaxed text-ink-soft">
        These are the fastest official routes available today. Follow them in order. Don&apos;t wait on any app.
      </p>

      <SafetyNotice className="mt-8" />

      <ol className="mt-10 space-y-4">
        {STEPS.map(({ icon: Icon, title, body, action }, i) => (
          <li key={title} className="flex gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-soft sm:gap-5 sm:p-6">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-ink-muted">Step {i + 1}</p>
              <h2 className="mt-1 text-lg font-semibold text-ink">{title}</h2>
              <p className="mt-1.5 leading-relaxed text-ink-soft">{body}</p>
              {action && (
                <a
                  href={action.href}
                  {...(action.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-ink/85"
                >
                  {action.label}
                  {action.href.startsWith("http") && <ExternalIcon className="size-3.5" />}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>

      <section className="mt-10 rounded-[var(--radius-card)] border border-brand-100 bg-brand-50/60 p-6">
        <div className="flex gap-3">
          <InfoIcon className="mt-0.5 size-5 shrink-0 text-brand-600" />
          <div>
            <h2 className="font-semibold text-ink">Post a request on MarutiX too</h2>
            <p className="mt-1.5 leading-relaxed text-ink-soft">
              It takes about two minutes and needs no account. Our team verifies it with the hospital, and you get a private link to track it.
              It doesn&apos;t replace the steps above, and MarutiX can&apos;t guarantee blood availability.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <ButtonLink href="/request">Request blood</ButtonLink>
              <BecomeDonorButton variant="secondary">Become a Donor</BecomeDonorButton>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
