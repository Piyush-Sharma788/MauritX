import type { Metadata } from "next";
import Link from "next/link";

import { Suspense } from "react";
import { CreateInstitutionForm } from "@/components/admin/admin-actions";
import { Card, EmptyState, PageHeader, Pill } from "@/components/admin/kit";
import { Droplet, Hospital } from "lucide-react";
import { FacilityMap, MapLegend, type MapPoint } from "@/components/maps/facility-map";
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
  const points: MapPoint[] = institutions
    .filter((i) => i.location)
    .map((i) => ({
      id: i.id,
      latitude: i.location!.latitude,
      longitude: i.location!.longitude,
      name: i.displayName,
      kind: i.type,
      verified: i.verificationStatus === "verified",
      detail: `${CAPABILITY_LABELS[i.capability]} · ${i.city}`,
      href: `/admin/institutions/${i.id}`,
      hrefLabel: "Open record",
    }));

  return (
    <div className="mt-8 space-y-6">
      {points.length > 0 && (
        <Card title="Map" id="map" note={`${points.length} of ${institutions.length} institutions have a map position. Hollow pins are not verified yet.`}>
          <FacilityMap points={points} ariaLabel="Map of hospitals and blood banks" className="h-80 sm:h-96" />
          <MapLegend className="mt-2.5" />
        </Card>
      )}
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
              <Link key={f.key} href={f.key ? `/admin/institutions?review=${f.key}` : "/admin/institutions"} aria-current={(review ?? "") === f.key ? "page" : undefined} className={`inline-flex min-h-10 items-center rounded-lg border px-3 text-xs font-medium transition-colors ${(review ?? "") === f.key ? "border-brand-500 bg-brand-50 text-brand-700 shadow-brut-xs" : "border-line bg-surface text-ink hover:bg-signal-100"}`}>{f.label}</Link>
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
                <span className="flex min-w-0 items-start gap-3">
                  <span aria-hidden="true" className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg ${i.type === "blood_bank" ? "bg-brand-50 text-brand-600" : "bg-signal-100 text-signal-800"}`}>
                    {i.type === "blood_bank" ? <Droplet className="size-4" /> : <Hospital className="size-4" />}
                  </span>
                  <span className="min-w-0">
                  <Link href={`/admin/institutions/${i.id}`} className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:text-brand-600 hover:decoration-brand-300">{i.displayName}</Link>
                  <span className="block text-xs text-ink-muted">{CAPABILITY_LABELS[i.capability]} · {i.locality}, {i.city} · {i.contactChannels} contact{i.contactChannels === 1 ? "" : "s"} · {i.verifiedContacts} WhatsApp contact{i.verifiedContacts === 1 ? "" : "s"} · {i.source === "openstreetmap" ? "discovered" : "added"} {formatIST(i.createdAt)}</span>
                  </span>
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
