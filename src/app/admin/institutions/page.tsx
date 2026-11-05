import type { Metadata } from "next";
import Link from "next/link";

import { Suspense } from "react";
import { CreateInstitutionForm } from "@/components/admin/admin-actions";
import { Card, EmptyState, PageHeader, Pill } from "@/components/admin/kit";
import { formatIST } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { CAPABILITY_LABELS } from "@/features/coordination/schemas";
import { requireAdminPage } from "@/lib/auth/require-admin";
import { listInstitutions } from "@/server/institutions/service";

export const metadata: Metadata = { title: "Institutions · Admin", robots: { index: false } };

const STATUS_TONE = { pending: "warn", verified: "good", rejected: "bad", suspended: "bad" } as const;

export default function InstitutionsPage({ searchParams }: PageProps<"/admin/institutions">) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <PageHeader eyebrow="Coordination" title="Hospitals & blood banks" />
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <InstitutionsContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const FILTERS = [
  { key: "", label: "All" },
  { key: "unreviewed", label: "Needs review" },
  { key: "approved", label: "Approved" },
  { key: "excluded", label: "Excluded" },
] as const;

async function InstitutionsContent({ searchParams }: Pick<PageProps<"/admin/institutions">, "searchParams">) {
  await requireAdminPage("admin.access");
  const raw = (await searchParams).review;
  const review = raw === "unreviewed" || raw === "approved" || raw === "excluded" ? raw : undefined;
  const institutions = await listInstitutions({ review });

  return (
    <div className="mt-8 space-y-6">
      <Card title="Add an institution" id="add" note="Added as pending. Verify only after checking the licence and identity documents offline. A WhatsApp number never grants access on its own.">
        <CreateInstitutionForm />
      </Card>
      <Card
        title="All institutions"
        id="list"
        note="Discovered institutions come from OpenStreetMap (© OpenStreetMap contributors, ODbL). They are never verified automatically: review them before their contacts are used."
        actions={
          <nav aria-label="Filter" className="flex gap-1">
            {FILTERS.map((f) => (
              <Link key={f.key} href={f.key ? `/admin/institutions?review=${f.key}` : "/admin/institutions"} aria-current={(review ?? "") === f.key ? "page" : undefined} className={`inline-flex min-h-10 items-center rounded-md border-2 px-3 text-xs font-bold transition-colors ${(review ?? "") === f.key ? "border-ink bg-ink text-white shadow-[3px_3px_0_0_var(--color-brand-500)]" : "border-ink bg-surface text-ink hover:bg-signal-300"}`}>{f.label}</Link>
            ))}
          </nav>
        }
      >
        {institutions.length === 0 ? (
          <EmptyState>{review ? "No institutions in this list." : "No institutions yet."}</EmptyState>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {institutions.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  <Link href={`/admin/institutions/${i.id}`} className="font-bold text-brand-700 underline decoration-2 underline-offset-4 hover:text-brand-600">{i.displayName}</Link>
                  <span className="block text-xs text-ink-muted">{CAPABILITY_LABELS[i.capability]} · {i.locality}, {i.city} · {i.contactChannels} contact{i.contactChannels === 1 ? "" : "s"} · {i.verifiedContacts} WhatsApp contact{i.verifiedContacts === 1 ? "" : "s"} · {i.source === "openstreetmap" ? "discovered" : "added"} {formatIST(i.createdAt)}</span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {i.reviewStatus !== "approved" && <Pill tone={i.reviewStatus === "excluded" ? "neutral" : "warn"}>{i.reviewStatus === "unreviewed" ? "needs review" : "excluded"}</Pill>}
                  <Pill tone={STATUS_TONE[i.verificationStatus]}>{i.verificationStatus}</Pill>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
