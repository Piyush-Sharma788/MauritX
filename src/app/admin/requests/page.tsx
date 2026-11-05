import type { Metadata } from "next";
import Link from "next/link";

import { Suspense } from "react";
import { z } from "zod";
import { StatusBadge, formatIST } from "@/components/requests/status";
import { Spinner, buttonClasses } from "@/components/ui/button";
import { Badge, EmptyBlock, PageHeader, StatTile, table } from "@/components/ui/primitives";
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
      <PageHeader eyebrow="Emergency requests" title="Request management" />
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
          <StatTile as="li" key={card.key} label={card.label} value={counts[card.key]} tone={card.key === "pending_verification" && counts[card.key] > 0 ? "warn" : "neutral"} />
        ))}
      </ul>
      <p className="-mt-3 text-xs text-ink-muted">“Active” includes verified requests ({stats.byStatus.verified} verified, {stats.byStatus.active} active). Counts come straight from the database.</p>

      <form method="get" className="grid gap-3 rounded-[var(--radius-card)] border-2 border-ink bg-paper-deep p-4 shadow-brut sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_0.8fr_1fr_auto]">
        <label className="text-xs font-bold text-ink">Request ID
          <input name="q" defaultValue={filters.q ?? ""} placeholder="MX-7K3Q9P2A" className={`${inputClasses} mt-1 h-11 border-line-strong font-mono text-sm uppercase`} />
        </label>
        <label className="text-xs font-bold text-ink">Status
          <select name="status" defaultValue={filters.status ?? ""} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`}>
            <option value="">All statuses</option>
            {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold text-ink">Blood group
          <select name="bloodGroup" defaultValue={filters.bloodGroup ?? ""} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`}>
            <option value="">All</option>
            {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g === "unknown" ? "Not sure" : BLOOD_GROUP_LABELS[g]}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold text-ink">City
          <input name="city" defaultValue={filters.city ?? ""} placeholder="Any city" className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`} />
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className={buttonClasses({ variant: "primary", className: "text-sm" })}>Apply</button>
          {filtered && <Link href="/admin/requests" className={buttonClasses({ variant: "ghost", className: "text-sm" })}>Reset</Link>}
        </div>
      </form>

      <section className={table.frame}>
        {requests.length === 0 ? (
          <EmptyBlock className="m-4">{filtered ? "No requests match these filters." : "No requests yet."}</EmptyBlock>
        ) : (
          <div className={table.scroll}>
            <table className={`${table.table} min-w-[56rem]`}>
              <thead className={table.head}>
                <tr>
                  {["Request", "Status", "Need", "Hospital", "Needed by", "Created"].map((h) => <th key={h} scope="col" className={table.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody className={table.body}>
                {requests.map((r) => (
                  <tr key={r.publicRequestId} className={table.row}>
                    <td className={table.td}>
                      <Link href={`/admin/requests/${r.publicRequestId}`} className="whitespace-nowrap font-mono font-bold text-brand-700 underline decoration-2 underline-offset-4 hover:text-brand-600">{r.publicRequestId}</Link>
                      {r.priority === "critical" && <Badge tone="bad" className="ml-2">{PRIORITY_LABELS.critical.label}</Badge>}
                    </td>
                    <td className={table.td}><StatusBadge status={r.status} /></td>
                    <td className={`${table.td} text-ink`}><strong>{r.bloodGroup === "unknown" ? "?" : BLOOD_GROUP_LABELS[r.bloodGroup]}</strong> · {r.unitsRequested} × {COMPONENT_LABELS[r.component]}</td>
                    <td className={`${table.td} text-ink-soft`}>{r.hospitalName}<span className="block text-xs text-ink-muted">{r.locality}, {r.city}</span></td>
                    <td className={`${table.td} whitespace-nowrap font-mono text-xs text-ink-soft`}>{formatIST(r.requiredBy)}</td>
                    <td className={`${table.td} whitespace-nowrap font-mono text-xs text-ink-soft`}>{formatIST(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {nextHref && (
        <div className="flex justify-end">
          <Link href={nextHref} className={buttonClasses({ variant: "secondary", className: "text-sm" })}>Older requests →</Link>
        </div>
      )}
    </div>
  );
}
