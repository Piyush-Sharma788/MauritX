import type { Metadata } from "next";
import { Badge, PageHeader } from "@/components/ui/primitives";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";

export const metadata: Metadata = {
  title: "Privacy notice",
  description: "How MarutiX handles your mobile number and donor details.",
};


const SECTIONS = [
  {
    title: "What we collect when you sign in",
    body: [
      "Your mobile number. We use it to send you a one-time sign-in code and to identify your account.",
      "Basic security records, such as when a code was requested or a session was created. These never include your code, your full number or your IP address.",
    ],
  },
  {
    title: "If you register as a donor",
    body: [
      "Registration happens in a WhatsApp chat with MarutiX. We take your mobile number from the chat itself, so you never type it.",
      "Your name, blood group (or “not sure”), city and locality, and whether you're available to donate. Optionally, your approximate location and the date you last donated.",
      "We use these only to reach you about nearby blood requests you could help with. We never ask for medical history, and your details are never shown publicly.",
      "If you share your location, we store it only to about 1 km. Your city and locality are always enough if you'd rather not share it.",
      "Your answers are saved while you register so you can continue later, and the in-progress copy is deleted once you finish or cancel (or after 30 days without a reply).",
      "To view or change your profile on the website, you sign in with a one-time code sent to the same number.",
    ],
  },
  {
    title: "If you request blood",
    body: [
      "We collect the patient's name or initials (and age, if you give it), the contact person's name and mobile number, what blood is needed, the hospital's details, and, only if you allow it, your device's approximate location (about 100 m).",
      "The patient's name and the contact details are encrypted. Only MarutiX staff verifying the request can see them, and they may call you or the hospital to verify it.",
      "Tracking links show the blood need, hospital and status history, never the patient's name, your number or your location. Links expire, and you or MarutiX can turn them off.",
      "A WhatsApp confirmation is sent only if you ask for it. It contains the request ID and a view-only link, never patient details.",
      "In later phases, only the blood need, hospital and area may be shared with verified blood centres and opted-in donors who can help. Patient names and contact numbers are not shared without consent.",
      "How long request records are kept will be set with legal advice and published here.",
    ],
  },
  {
    title: "Your alert choices",
    body: [
      "Emergency alerts are off unless you clearly agree to them. We keep a record of when you agreed, paused, resumed or stopped, and which version of this notice applied.",
      "You can pause, resume or stop alerts at any time by replying PAUSE, RESUME or STOP on WhatsApp, or on the website. STOP takes effect immediately and stops all MarutiX messages.",
    ],
  },
  {
    title: "How the code reaches you",
    body: [
      "Codes are sent through Meta's official WhatsApp Business Platform. Meta processes the message to deliver it to you.",
      "Codes expire after 5 minutes and can be used only once. We store only a one-way hash of each code, never the code itself.",
    ],
  },
  {
    title: "How we protect your number",
    body: [
      "Your number is encrypted before it's stored, and it's never shown to other users, requesters or the public.",
      "Sign-in sessions use a secure, HTTP-only cookie. Signing out ends the session on our servers immediately.",
    ],
  },
  {
    title: "Pilot WhatsApp messages",
    body: [
      "During our pilot, donor alerts and replies to STOP or HELP are sent from a MarutiX WhatsApp number linked through WhatsApp Web. This is not Meta's WhatsApp Business Platform.",
      "We message a number only after its owner opts in, and never more than a limited number of messages per hour. Reply STOP at any time to stop all messages.",
      "We keep the text of a message only until it is sent or fails. After that we keep its delivery status, time and a masked number.",
    ],
  },
  {
    title: "What we don't do",
    body: [
      "We don't sell your data or use it for advertising.",
      "We don't ask for Aadhaar, identity documents or medical history to sign in.",
      "We don't send donor alerts unless you've opted in, and we never message people who replied STOP.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="max-w-3xl">
        <PageHeader
          size="lg"
          eyebrow="Privacy notice"
          title="Your number, handled with care."
          description="This notice covers signing in, donor registration and emergency blood requests during early access."
        />
        <p className="mt-5">
          <Badge tone="warn">Version {PRIVACY_NOTICE_VERSION} · Draft pending legal review</Badge>
        </p>
      </div>

      <div className="mt-12 grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="On this page" className="hidden lg:block">
          <div className="sticky top-24 rounded-md border-2 border-ink bg-surface shadow-brut-sm">
            <p className="eyebrow border-b-2 border-ink bg-ink px-3 py-2 text-white">On this page</p>
            <ol className="p-2 text-sm">
              {SECTIONS.map((section, i) => (
                <li key={section.title}>
                  <a href={`#s${i + 1}`} className="flex gap-2 rounded-sm px-2 py-1.5 font-medium text-ink hover:bg-signal-300">
                    <span className="font-mono text-xs font-bold text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>
        <div className="max-w-3xl space-y-6">
          {SECTIONS.map((section, i) => (
            <section id={`s${i + 1}`} key={section.title} className="scroll-mt-24 rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut sm:p-7">
              <h2 className="flex items-baseline gap-3 font-display text-xl font-extrabold tracking-[-0.025em] text-ink sm:text-2xl">
                <span className="font-mono text-sm font-bold text-brand-600">{String(i + 1).padStart(2, "0")}</span>
                {section.title}
              </h2>
              <ul className="mt-4 space-y-2.5 leading-relaxed text-ink-soft">
                {section.body.map((line) => (
                  <li key={line} className="flex gap-3">
                    <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 bg-brand-500" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
