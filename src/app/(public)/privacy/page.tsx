import type { Metadata } from "next";
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
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">Privacy notice</p>
      <h1 className="mt-3 font-display text-4xl font-bold tracking-[-0.04em] text-ink sm:text-5xl">Your number, handled with care.</h1>
      <p className="mt-5 text-lg leading-relaxed text-ink-soft">
        This notice covers signing in, donor registration and emergency blood requests during early access.
      </p>
      <p className="mt-4 inline-flex rounded-full bg-paper-deep px-3 py-1 text-xs font-medium text-ink-soft">
        Version {PRIVACY_NOTICE_VERSION} · Draft pending legal review
      </p>

      <div className="mt-10 space-y-5">
        {SECTIONS.map((section) => (
          <section key={section.title} className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-soft">
            <h2 className="text-lg font-semibold text-ink">{section.title}</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed text-ink-soft marker:text-brand-400">
              {section.body.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
