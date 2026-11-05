import type { Metadata } from "next";
import { BecomeDonorButton } from "@/components/donor/become-donor-button";
import { SafetyNotice } from "@/components/landing/safety-notice";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { ExternalIcon, InfoIcon, PhoneIcon, StethoscopeIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/primitives";

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
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <PageHeader
        size="lg"
        eyebrow="Find blood / get help"
        title={<>Someone needs blood. <span className="text-brand-600">Here&apos;s what to do right now.</span></>}
        description="These are the fastest official routes available today. Follow them in order. Don't wait on any app."
      />

      <SafetyNotice className="mt-8" />

      <ol className="mt-10 space-y-5">
        {STEPS.map(({ icon: Icon, title, body, action }, i) => (
          <li key={title} className="relative flex overflow-hidden rounded-[var(--radius-card)] border-2 border-ink bg-surface shadow-brut">
            <span aria-hidden="true" className={`flex w-14 shrink-0 flex-col items-center gap-3 border-r-2 border-ink pt-5 sm:w-20 ${i === 2 ? "bg-brand-500 text-white" : i === 1 ? "bg-mint-300 text-ink" : "bg-signal-300 text-ink"}`}>
              <span className="font-display text-3xl font-extrabold leading-none sm:text-4xl">{i + 1}</span>
              <Icon className="size-5" />
            </span>
            <div className="min-w-0 p-5 sm:p-6">
              <p className="eyebrow text-ink-muted">Step {i + 1}</p>
              <h2 className="mt-1.5 font-display text-xl font-extrabold leading-tight tracking-[-0.025em] text-ink sm:text-[1.4rem]">{title}</h2>
              <p className="mt-2 leading-relaxed text-ink-soft">{body}</p>
              {action && (
                <a
                  href={action.href}
                  {...(action.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className={buttonClasses({ variant: action.href.startsWith("tel:") ? "primary" : "secondary", className: "mt-5 text-sm" })}
                >
                  {action.href.startsWith("tel:") && <PhoneIcon className="size-4" />}
                  {action.label}
                  {action.href.startsWith("http") && <ExternalIcon className="size-4" />}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>

      <section className="mt-12 rounded-[var(--radius-card)] border-2 border-ink bg-brand-50 p-6 shadow-brut-lg sm:p-8">
        <div className="flex gap-4">
          <span aria-hidden="true" className="hidden size-11 shrink-0 items-center justify-center rounded-sm border-2 border-ink bg-ink text-white sm:flex">
            <InfoIcon className="size-5" />
          </span>
          <div>
            <h2 className="font-display text-2xl font-extrabold tracking-[-0.03em] text-ink">Post a request on MarutiX too</h2>
            <p className="mt-2 leading-relaxed text-ink-soft">
              It takes about two minutes and needs no account. Our team verifies it with the hospital, and you get a private link to track it.
              It doesn&apos;t replace the steps above, and MarutiX can&apos;t guarantee blood availability.
            </p>
            <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <ButtonLink href="/request">Request blood</ButtonLink>
              <BecomeDonorButton variant="secondary">Become a Donor</BecomeDonorButton>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
