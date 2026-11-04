import type { Metadata } from "next";
import { RequestForm } from "@/components/requests/request-form";
import { AlertIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Request blood",
  description: "Create an emergency blood request on MarutiX. No account needed.",
  robots: { index: false },
};

export default function RequestBloodPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">Emergency request</p>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.04em] text-ink sm:text-4xl">Request blood</h1>
      <p className="mt-3 text-ink-soft">No account needed. MarutiX verifies every request with the hospital before marking it verified.</p>
      <p className="mt-4 flex gap-2.5 rounded-2xl border border-danger-600/20 bg-danger-50 px-4 py-3 text-sm leading-relaxed text-danger-600">
        <AlertIcon className="mt-0.5 size-4.5 shrink-0" />
        <span>
          <strong>If life is at risk, call <a href="tel:112" className="underline">112</a> now</strong> and speak to the hospital&apos;s blood bank. Don&apos;t wait on this request.
        </span>
      </p>
      <div className="mt-6">
        <RequestForm />
      </div>
    </div>
  );
}
