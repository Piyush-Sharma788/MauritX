import type { Metadata } from "next";
import Link from "next/link";

import { Suspense } from "react";
import { z } from "zod";
import { StatusBadge, formatIST } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/form";
import { BLOOD_GROUP_LABELS, BLOOD_GROUPS } from "@/features/donors/schemas";
import { COMPONENT_LABELS, PRIORITY_LABELS, publicRequestIdSchema, REQUEST_STATUSES, STATUS_LABELS } from "@/features/requests/schemas";
import { requireAdminPage } from "@/lib/auth/require-admin";
import { listRequests } from "@/server/requests/service";

export const metadata: Metadata = { title: "Requests · Admin", robots: { index: false } };

const filtersSchema = z.object({
  q: publicRequestIdSchema.optional().catch(undefined),
  status: z.enum(REQUEST_STATUSES).optional().catch(undefined),
  bloodGroup: z.enum(BLOOD_GROUPS).optional().catch(undefined),
  city: z.string().trim().min(1).max(60).optional().catch(undefined),
  cursor: z.string().regex(/^[a-f0-9]{24}$/).optional().catch(undefined),
});

export default function AdminRequestsPage({ searchParams }: PageProps<"/admin/requests">) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">Emergency requests</p>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.035em] text-ink sm:text-4xl">Request management</h1>
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <RequestsContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const STAT_CARDS = [
  { key: "total", label: "Total requests" },
  { key: "pending_verification", label: "Pending verification" },
  { key: "active", label: "Active" },
  { key: "partially_fulfilled", label: "Partially fulfilled" },
  { key: "fulfilled", label: "Fulfilled" },
  { key: "closed", label: "Cancelled / expired" },
] as const;

async function RequestsContent({ searchParams }: Pick<PageProps<"/admin/requests">, "searchParams">) {
  await requireAdminPage("requests.manage");

  const raw = Object.fromEntries(Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" && v !== "" ? [[k, v]] : [])));
  const filters = filtersSchema.parse(raw);
  const { stats, requests, nextCursor } = await listRequests(filters);
  const counts: Record<(typeof STAT_CARDS)[number]["key"], number> = {
    total: stats.total,
    pending_verification: stats.byStatus.pending_verification,
    active: stats.byStatus.active + stats.byStatus.verified,
    partially_fulfilled: stats.byStatus.partially_fulfilled,
    fulfilled: stats.byStatus.fulfilled,
    closed: stats.byStatus.cancelled + stats.byStatus.expired,
  };
  const filtered = Boolean(filters.q || filters.status || filters.bloodGroup || filters.city);
  const nextHref = nextCursor ? `/admin/requests?${new URLSearchParams({ ...raw, cursor: nextCursor }).toString()}` : null;

  return (
    <div className="mt-8 space-y-6">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STAT_CARDS.map((card) => (
          <li key={card.key} className={`rounded-2xl border p-4 shadow-soft ${card.key === "pending_verification" && counts[card.key] > 0 ? "border-warning-200 bg-warning-50" : "border-line bg-surface"}`}>
            <p className="text-xs font-medium text-ink-muted">{card.label}</p>
            <p className="mt-1 font-display text-3xl font-bold tracking-tight text-ink">{counts[card.key]}</p>
          </li>
        ))}
      </ul>
      <p className="-mt-3 text-xs text-ink-muted">“Active” includes verified requests ({stats.byStatus.verified} verified, {stats.byStatus.active} active). Counts come straight from the database.</p>

      <form method="get" className="grid gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-soft sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_0.8fr_1fr_auto]">
        <label className="text-xs font-semibold text-ink-soft">Request ID
          <input name="q" defaultValue={filters.q ?? ""} placeholder="MX-7K3Q9P2A" className={`${inputClasses} mt-1 h-11 border-line-strong font-mono text-sm uppercase`} />
        </label>
        <label className="text-xs font-semibold text-ink-soft">Status
          <select name="status" defaultValue={filters.status ?? ""} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`}>
            <option value="">All statuses</option>
            {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-ink-soft">Blood group
          <select name="bloodGroup" defaultValue={filters.bloodGroup ?? ""} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`}>
            <option value="">All</option>
            {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g === "unknown" ? "Not sure" : BLOOD_GROUP_LABELS[g]}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-ink-soft">City
          <input name="city" defaultValue={filters.city ?? ""} placeholder="Any city" className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`} />
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className="h-11 rounded-full bg-ink px-5 text-sm font-semibold text-white hover:bg-ink/90">Apply</button>
          {filtered && <Link href="/admin/requests" className="h-11 rounded-full px-4 py-3 text-sm font-medium text-ink-soft hover:bg-ink/5">Reset</Link>}
        </div>
      </form>

      <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-soft">
        {requests.length === 0 ? (
          <p className="px-6 py-12 text-center text-ink-muted">{filtered ? "No requests match these filters." : "No requests yet."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="border-b border-line bg-paper-deep/50 text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  {["Request", "Status", "Need", "Hospital", "Needed by", "Created"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-semibold first:pl-6">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {requests.map((r) => (
                  <tr key={r.publicRequestId} className="hover:bg-paper/60">
                    <td className="px-4 py-3 pl-6">
                      <Link href={`/admin/requests/${r.publicRequestId}`} className="font-mono font-semibold text-brand-600 hover:text-brand-700">{r.publicRequestId}</Link>
                      {r.priority === "critical" && <span className="ml-2 rounded-full bg-danger-50 px-2 py-0.5 text-[0.7rem] font-semibold text-danger-600">{PRIORITY_LABELS.critical.label}</span>}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 text-ink"><strong>{r.bloodGroup === "unknown" ? "?" : BLOOD_GROUP_LABELS[r.bloodGroup]}</strong> · {r.unitsRequested} × {COMPONENT_LABELS[r.component]}</td>
                    <td className="px-4 py-3 text-ink-soft">{r.hospitalName}<span className="block text-xs text-ink-muted">{r.locality}, {r.city}</span></td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-soft">{formatIST(r.requiredBy)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-soft">{formatIST(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {nextHref && (
        <div className="flex justify-end">
          <Link href={nextHref} className="rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink hover:bg-paper-deep">Older requests →</Link>
        </div>
      )}
    </div>
  );
}
