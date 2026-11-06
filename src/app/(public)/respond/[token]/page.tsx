import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { InstitutionResponseForm } from "@/components/requests/institution-response-form";
import { formatIST } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import { COMPONENT_LABELS, PRIORITY_LABELS, TRACKING_TOKEN } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import { getOutreachPage } from "@/server/outreach/service";

export const metadata: Metadata = { title: "Respond to a blood request", robots: { index: false, follow: false } };

export default function RespondPage({ params }: PageProps<"/respond/[token]">) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: Pick<PageProps<"/respond/[token]">, "params">) {
  const { token } = await params;
  // Link validity depends on the current time.
  await connection();
  let page = null;
  let problem = "This link isn't valid. Please contact the MarutiX coordinator.";
  if (TRACKING_TOKEN.test(token)) {
    try {
      page = await getOutreachPage(token);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === "TRACKING_LINK_EXPIRED") problem = "This request has closed, so this link has expired. Thank you.";
    }
  }
  if (!page) {
    return (
      <section className="rounded-[var(--radius-card)] border border-line bg-surface p-8 text-center shadow-brut-sm">
        <span aria-hidden="true" className="mx-auto flex size-14 items-center justify-center rounded-md border border-line bg-signal-300 shadow-brut-sm"><InfoIcon className="size-7 text-ink" /></span>
        <p className="mt-4 text-ink-soft">{problem}</p>
      </section>
    );
  }
  return (
    <div className="space-y-5">
      <header className="relative overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-brut-sm sm:p-8">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-2 bg-stripes" />
        <p className="eyebrow text-brand-600">MarutiX emergency coordination</p>
        <h1 className="mt-3 font-display text-3xl font-semibold leading-[1.02] tracking-[-0.03em] text-ink sm:text-4xl">
          {page.bloodGroup === "unknown" ? "Blood" : BLOOD_GROUP_LABELS[page.bloodGroup]} · {page.unitsRequested} × {COMPONENT_LABELS[page.component]}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">For {page.institutionName}</p>
        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2 [&>div]:border-l [&>div]:border-line [&>div]:pl-3 [&_dt]:text-xs [&_dt]:font-medium">
          <div><dt className="text-ink-muted">Request</dt><dd className="font-mono font-semibold text-ink">{page.publicRequestId}{page.verified ? " · verified by MarutiX" : ""}</dd></div>
          <div><dt className="text-ink-muted">Priority</dt><dd className="font-bold text-ink">{PRIORITY_LABELS[page.priority].label}</dd></div>
          <div><dt className="text-ink-muted">Required by</dt><dd className="font-bold text-ink">{formatIST(page.requiredBy)}</dd></div>
          <div><dt className="text-ink-muted">Patient location</dt><dd className="font-bold text-ink">{page.hospital}</dd></div>
        </dl>
        {(page.coordinator.phone || page.coordinator.email) && (
          <p className="mt-4 text-sm text-ink-soft">MarutiX coordinator: {[page.coordinator.phone, page.coordinator.email].filter(Boolean).join(" · ")}</p>
        )}
      </header>
      {page.open ? (
        <InstitutionResponseForm token={token} current={page.response} emailOptOutAvailable={page.emailOptOutAvailable} />
      ) : (
        <p className="rounded-md border border-line bg-paper px-4 py-3 text-sm text-ink-soft">This request is closed. Thank you for looking.</p>
      )}
      <p className="text-xs leading-relaxed text-ink-muted">MarutiX is a voluntary coordination service. It doesn&apos;t hold blood and doesn&apos;t treat a reply as confirmed stock. Patient details are shared only with the treating hospital.</p>
    </div>
  );
}
