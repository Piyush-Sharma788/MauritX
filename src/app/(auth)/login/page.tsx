import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PhoneLoginFlow } from "@/components/auth/phone-login-flow";
import { Spinner } from "@/components/ui/button";
import { ChatIcon, HandshakeIcon, LockIcon, ShieldIcon } from "@/components/ui/icons";
import { getCurrentUser } from "@/lib/auth/current-user";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false },
};

const POINTS = [
  { icon: ChatIcon, title: "Registered on WhatsApp?", body: "Sign in with the same number to see and manage your donor profile." },
  { icon: LockIcon, title: "Encrypted number", body: "Stored encrypted. Never shown publicly." },
  { icon: HandshakeIcon, title: "You stay in control", body: "No alerts unless you opt in. Pause or delete any time." },
];

export default function LoginPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-10 px-4 pb-16 pt-6 sm:px-6 lg:grid-cols-[1fr_minmax(0,28rem)] lg:gap-20 lg:pb-24 lg:pt-10">
      <section className="order-2 hidden lg:order-1 lg:block" aria-label="Why sign in with MarutiX">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">Secure sign-in</p>
        <h2 className="mt-3 max-w-md font-display text-5xl font-bold leading-[1.04] tracking-[-0.045em] text-ink">
          One number. One code. <span className="text-brand-500">No passwords.</span>
        </h2>
        <ul className="mt-10 max-w-md space-y-6">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <Icon className="size-5" />
              </span>
              <span>
                <span className="block font-semibold text-ink">{title}</span>
                <span className="mt-0.5 block text-ink-soft">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="order-1 w-full lg:order-2">
        <div className="rounded-[1.75rem] border border-line bg-surface p-6 shadow-lift sm:p-8">
          <Suspense fallback={<FormSkeleton />}>
            <LoginForm />
          </Suspense>
        </div>
        <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs text-ink-muted">
          <ShieldIcon className="size-4" /> Codes expire in 5 minutes and work only once.
        </p>
      </div>
    </div>
  );
}

async function LoginForm() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  return <PhoneLoginFlow />;
}

function FormSkeleton() {
  return (
    <div className="flex min-h-80 items-center justify-center text-ink-muted" role="status">
      <Spinner className="size-6" />
      <span className="sr-only">Loading sign-in</span>
    </div>
  );
}
