import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AddContactForm, ContactStatusButtons, InstitutionStatusButtons } from "@/components/admin/admin-actions";
import { Card, EmptyState, Pill } from "@/components/admin/kit";
import { formatIST, StatusBadge } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { ArrowLeftIcon, LockIcon } from "@/components/ui/icons";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import { COMPONENT_LABELS } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getInstitutionDetail } from "@/server/institutions/service";

export const metadata: Metadata = { title: "Institution · Admin", robots: { index: false } };

const STATUS_TONE = { pending: "warn", verified: "good", rejected: "bad", suspended: "bad" } as const;

export default function InstitutionDetailPage({ params }: PageProps<"/admin/institutions/[institutionId]">) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/admin/institutions" className="-ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-ink-soft hover:bg-ink/5 hover:text-ink">
        <ArrowLeftIcon className="size-4" /> All institutions
      </Link>
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <Detail params={params} />
      </Suspense>
    </div>
  );
}

async function Detail({ params }: Pick<PageProps<"/admin/institutions/[institutionId]">, "params">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") notFound();
  const { institutionId } = await params;
  let i;
  try {
    i = await getInstitutionDetail(institutionId);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  return (
    <div className="mt-4 space-y-5">
      <header className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-soft sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Pill tone={STATUS_TONE[i.verificationStatus]}>{i.verificationStatus}</Pill>
          <h1 className="mt-3 font-display text-2xl font-bold text-ink sm:text-3xl">{i.displayName}</h1>
          <p className="mt-1 text-sm text-ink-soft">{i.type === "blood_bank" ? "Blood bank" : "Hospital"} · {i.legalName}</p>
          <p className="mt-1 text-sm text-ink-soft">{i.address}, {i.locality}, {i.city}{i.publicPhone ? ` · ${i.publicPhone}` : ""}</p>
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-muted"><LockIcon className="size-3.5" /> Licence: {i.licenceReference ?? "not recorded"}{i.verifiedAt ? ` · verified ${formatIST(i.verifiedAt)}` : ""}</p>
        </div>
        <InstitutionStatusButtons id={i.id} status={i.verificationStatus} />
      </header>

      <Card title="WhatsApp contacts" id="contacts" note="A number gets institutional commands only while both the contact and the institution are verified. Only coordinators can confirm fulfilment.">
        {i.contacts.length === 0 ? (
          <EmptyState>No contacts yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {i.contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span>
                  <span className="font-medium text-ink">{c.name}</span> <Pill tone={c.status === "verified" ? "good" : c.status === "pending" ? "warn" : "neutral"}>{c.status}</Pill>
                  <span className="block text-xs text-ink-muted">{c.maskedPhone} · {c.role}{c.verifiedAt ? ` · verified ${formatIST(c.verifiedAt)}` : ""}</span>
                </span>
                <ContactStatusButtons institutionId={i.id} contactId={c.id} status={c.status} />
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 border-t border-line pt-5"><AddContactForm institutionId={i.id} /></div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Availability reports" id="availability" note="Self-reported by the institution on WhatsApp, with time and reporter. Never confirmed live stock.">
          {i.availability.length === 0 ? (
            <EmptyState>No reports yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {i.availability.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="font-medium text-ink">{BLOOD_GROUP_LABELS[r.bloodGroup]} · {COMPONENT_LABELS[r.component]}</span>
                  <span className="text-right text-xs text-ink-muted">{r.status === "available" ? `${r.units} unit(s) reported` : "None reported"}<span className="block">{r.reportedBy} · {formatIST(r.reportedAt)}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Open linked requests" id="requests">
          {i.openRequests.length === 0 ? (
            <EmptyState>No open requests are linked to this institution.</EmptyState>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {i.openRequests.map((r) => (
                <li key={r.publicRequestId} className="flex items-center justify-between gap-3 py-2.5">
                  <Link href={`/admin/requests/${r.publicRequestId}`} className="font-mono font-semibold text-brand-600">{r.publicRequestId}</Link>
                  <span className="flex items-center gap-2 text-xs text-ink-muted"><StatusBadge status={r.status} />{r.acknowledgedAt ? `acknowledged ${formatIST(r.acknowledgedAt)}` : "not acknowledged"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
