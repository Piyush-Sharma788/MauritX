import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { CreateInstitutionForm } from "@/components/admin/admin-actions";
import { Card, EmptyState, PageHeader, Pill } from "@/components/admin/kit";
import { formatIST } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listInstitutions } from "@/server/institutions/service";

export const metadata: Metadata = { title: "Institutions · Admin", robots: { index: false } };

const STATUS_TONE = { pending: "warn", verified: "good", rejected: "bad", suspended: "bad" } as const;

export default function InstitutionsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <PageHeader eyebrow="Coordination" title="Hospitals & blood banks" />
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <InstitutionsContent />
      </Suspense>
    </div>
  );
}

async function InstitutionsContent() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") notFound();
  const institutions = await listInstitutions();

  return (
    <div className="mt-8 space-y-6">
      <Card title="Add an institution" id="add" note="Added as pending. Verify only after checking the licence and identity documents offline. A WhatsApp number never grants access on its own.">
        <CreateInstitutionForm />
      </Card>
      <Card title="All institutions" id="list">
        {institutions.length === 0 ? (
          <EmptyState>No institutions yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {institutions.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  <Link href={`/admin/institutions/${i.id}`} className="font-semibold text-brand-600 hover:text-brand-700">{i.displayName}</Link>
                  <span className="block text-xs text-ink-muted">{i.type === "blood_bank" ? "Blood bank" : "Hospital"} · {i.locality}, {i.city} · {i.verifiedContacts} verified contact{i.verifiedContacts === 1 ? "" : "s"} · added {formatIST(i.createdAt)}</span>
                </span>
                <Pill tone={STATUS_TONE[i.verificationStatus]}>{i.verificationStatus}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
