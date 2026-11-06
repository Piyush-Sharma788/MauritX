import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";

export default function NotFound() {
  return (
    <main id="main" className="flex flex-1 flex-col bg-grid">
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6">
          <Logo />
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="animate-pop inline-block rounded-md border border-line bg-signal-300 px-5 py-1 font-display text-7xl font-semibold tracking-[-0.03em] text-ink shadow-brut-sm">404</p>
        <h1 className="mt-8 font-display text-4xl font-semibold tracking-[-0.03em] text-ink">This page doesn&apos;t exist.</h1>
        <p className="mt-3 text-lg text-ink-soft">The link may be mistyped or out of date.</p>
        <div className="mt-8 flex flex-col gap-4 sm:flex-row">
          <ButtonLink href="/">Go to home</ButtonLink>
          <ButtonLink href="/get-help" variant="secondary">Get help now</ButtonLink>
        </div>
        <p className="mt-8 text-sm text-ink-soft">
          Medical emergency? Call{" "}
          <Link href="tel:112" className="font-bold text-ink underline decoration-brand-300 underline-offset-2">112</Link>.
        </p>
      </div>
    </main>
  );
}
