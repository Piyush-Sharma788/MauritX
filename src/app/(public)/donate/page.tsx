import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import { BecomeDonorButton } from "@/components/donor/become-donor-button";
import { ChatIcon, CheckIcon, InfoIcon, ShieldIcon } from "@/components/ui/icons";
import { Eyebrow, Notice } from "@/components/ui/primitives";
import { donorRegistrationChatUrl, marutixWhatsAppNumber } from "@/lib/whatsapp-web/public-chat";

export const metadata: Metadata = {
  title: "Become a donor",
  description: "Register as a voluntary blood donor by chatting with MarutiX on WhatsApp.",
};

const STEPS = [
  "Your name (full or preferred)",
  "Blood group, or “not sure”",
  "City and locality",
  "Optional: approximate location and last donation date",
  "Whether you're available, and whether you'd like emergency alerts",
];

function formatNumber(digits: string) {
  return digits.startsWith("91") && digits.length === 12 ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`;
}

export default async function DonatePage() {
  const url = donorRegistrationChatUrl();
  const number = marutixWhatsAppNumber();
  const qr = url ? await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <Eyebrow>Become a donor</Eyebrow>
      <h1 className="mt-3 max-w-3xl text-balance font-display text-[2.4rem] font-semibold leading-[0.98] tracking-[-0.03em] text-ink sm:text-6xl">
        Register in a <span className="marker">two‑minute</span> WhatsApp chat.
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">
        No forms and no passwords. Send <strong className="rounded-md border border-line bg-paper-deep px-1.5 font-mono text-[0.95em] text-ink">REGISTER</strong> to MarutiX on WhatsApp and answer a few quick questions.
        We use the number you message from, so there&apos;s nothing to type for it.
      </p>

      {url && qr && number ? (
        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_20rem]">
          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-brut-sm sm:p-8">
            <h2 className="font-display text-2xl font-semibold tracking-[-0.03em] text-ink">What the bot will ask</h2>
            <ul className="mt-5 space-y-3">
              {STEPS.map((step) => (
                <li key={step} className="flex gap-3 text-ink">
                  <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border border-line bg-mint-400">
                    <CheckIcon className="size-3" strokeWidth={3.5} />
                  </span>
                  {step}
                </li>
              ))}
            </ul>
            <Notice as="p" tone="info" className="mt-6">
              Reply BACK, CANCEL or HELP at any time, and STOP to stop all messages. Registering isn&apos;t a medical eligibility check.
            </Notice>
            <BecomeDonorButton size="lg" className="mt-6 w-full sm:w-auto">
              <ChatIcon className="size-5" /> Open WhatsApp
            </BecomeDonorButton>
          </section>
          <aside className="relative flex flex-col items-center rounded-[var(--radius-card)] border border-line bg-surface p-6 text-center shadow-brut-sm">
            <span aria-hidden="true" className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-brand-600 bg-brand-500 px-2.5 py-0.5 text-xs font-semibold text-white">Scan me</span>
            <p className="font-display text-xl font-semibold tracking-[-0.02em] text-ink">On a computer?</p>
            <p className="mt-1 text-sm text-ink">Scan with your phone&apos;s camera to open the chat.</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- server-generated SVG data URL */}
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(qr)}`} alt="QR code that opens the MarutiX WhatsApp chat" className="mt-5 aspect-square w-full max-w-56 rounded-md border border-line bg-white p-2 shadow-brut-sm" />
            <p className="mt-4 text-sm text-ink">
              Or message <strong className="whitespace-nowrap text-ink">REGISTER</strong> to <strong className="whitespace-nowrap text-ink">{formatNumber(number)}</strong>
            </p>
          </aside>
        </div>
      ) : (
        <section className="mt-10 flex gap-3 rounded-[var(--radius-card)] border border-dashed border-line bg-surface p-6">
          <InfoIcon className="mt-0.5 size-5 shrink-0 text-ink-soft" />
          <div>
            <h2 className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">WhatsApp registration isn&apos;t open yet</h2>
            <p className="mt-1.5 leading-relaxed text-ink-soft">
              We&apos;re finishing setting up the MarutiX WhatsApp number. Please check back soon. If someone needs blood now, see{" "}
              <Link href="/get-help" className="font-bold text-ink underline decoration-brand-300 underline-offset-2">Get Help</Link>.
            </p>
          </div>
        </section>
      )}

      <p className="mt-10 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <ShieldIcon className="size-4" />
        Already registered?{" "}
        <Link href="/login" className="font-bold text-ink underline decoration-brand-300 underline-offset-4 hover:decoration-brand-500">Sign in to manage your profile</Link>
      </p>
      <p className="mt-2 text-xs text-ink-muted">
        Messages come from the MarutiX pilot number, connected through WhatsApp Web (not Meta&apos;s Business Platform).
      </p>
    </div>
  );
}
