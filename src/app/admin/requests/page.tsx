import type { Metadata } from "next";
import Link from "next/link";

import { Suspense } from "react";
import { z } from "zod";
import { ArrowRight, Ban, CircleCheck, ClipboardList, Clock, Hospital, Siren, UserRoundCheck } from "lucide-react";
import { PriorityBadge, StageIndicator, STAGE_STYLES, STATUS_STAGE, StatusBadge, formatIST } from "@/components/requests/status";
import { Spinner, buttonClasses } from "@/components/ui/button";
import { EmptyBlock, PageHeader, StatTile } from "@/components/ui/primitives";
import { inputClasses } from "@/components/ui/form";
import { BLOOD_GROUP_LABELS, BLOOD_GROUPS } from "@/features/donors/schemas";
import { COMPONENT_LABELS, publicRequestIdSchema, REQUEST_STATUSES, STATUS_LABELS } from "@/features/requests/schemas";
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
  { key: "total", label: "Total requests", tone: "neutral", Icon: ClipboardList },
  { key: "pending_verification", label: "Pending verification", tone: "warn", Icon: Clock },
  { key: "active", label: "Active", tone: "bad", Icon: Siren },
  { key: "partially_fulfilled", label: "Partially fulfilled", tone: "info", Icon: UserRoundCheck },
  { key: "fulfilled", label: "Fulfilled", tone: "good", Icon: CircleCheck },
  { key: "closed", label: "Cancelled / expired", tone: "neutral", Icon: Ban },
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
          <StatTile as="li" key={card.key} label={card.label} value={counts[card.key]} tone={counts[card.key] > 0 ? card.tone : "neutral"} icon={<card.Icon className="size-4" />} />
        ))}
      </ul>
      <p className="-mt-3 text-xs text-ink-muted">“Active” includes verified requests ({stats.byStatus.verified} verified, {stats.byStatus.active} active). Counts come straight from the database.</p>

      <form method="get" className="grid gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-brut-xs sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_0.8fr_1fr_auto]">
        <label className="text-xs font-medium text-ink-soft">Request ID
          <input name="q" defaultValue={filters.q ?? ""} placeholder="MX-7K3Q9P2A" className={`${inputClasses} mt-1 h-11 border-line-strong font-mono text-sm uppercase`} />
        </label>
        <label className="text-xs font-medium text-ink-soft">Status
          <select name="status" defaultValue={filters.status ?? ""} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`}>
            <option value="">All statuses</option>
            {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-soft">Blood group
          <select name="bloodGroup" defaultValue={filters.bloodGroup ?? ""} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`}>
            <option value="">All</option>
            {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g === "unknown" ? "Not sure" : BLOOD_GROUP_LABELS[g]}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-soft">City
          <input name="city" defaultValue={filters.city ?? ""} placeholder="Any city" className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`} />
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className={buttonClasses({ variant: "primary", className: "text-sm" })}>Apply</button>
          {filtered && <Link href="/admin/requests" className={buttonClasses({ variant: "ghost", className: "text-sm" })}>Reset</Link>}
        </div>
      </form>

      {requests.length === 0 ? (
        <EmptyBlock>{filtered ? "No requests match these filters." : "No requests yet."}</EmptyBlock>
      ) : (
        <ul aria-label="Requests" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {requests.map((r) => {
            const stage = STATUS_STAGE[r.status];
            return (
              <li key={r.publicRequestId}>
                <Link
                  href={`/admin/requests/${r.publicRequestId}`}
                  className="group relative flex h-full flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface p-4 pl-5 shadow-brut-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-brut-sm"
                >
                  <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${STAGE_STYLES[stage].bar}`} />
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-50 font-display text-lg font-semibold tracking-[-0.02em] text-brand-700">
                        {r.bloodGroup === "unknown" ? "?" : BLOOD_GROUP_LABELS[r.bloodGroup]}
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-semibold text-ink">{r.publicRequestId}</p>
                        <p className="truncate text-sm text-ink-soft">{r.unitsRequested} × {COMPONENT_LABELS[r.component]}</p>
                      </div>
                    </div>
                    <StageIndicator status={r.status} className="shrink-0 pt-1" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <StatusBadge status={r.status} />
                    <PriorityBadge priority={r.priority} />
                  </div>
                  <dl className="mt-3 space-y-1.5 text-sm">
                    <div className="flex items-start gap-2">
                      <dt className="sr-only">Hospital</dt>
                      <Hospital aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                      <dd className="min-w-0 text-ink">{r.hospitalName}<span className="block text-xs text-ink-muted">{r.locality}, {r.city}</span></dd>
                    </div>
                    <div className="flex items-start gap-2">
                      <dt className="sr-only">Needed by</dt>
                      <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                      <dd className="text-ink-soft">Needed by <span className="tabular-nums text-ink">{formatIST(r.requiredBy)}</span></dd>
                    </div>
                  </dl>
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-ink-muted">
                    <span className="tabular-nums">Created {formatIST(r.createdAt)}</span>
                    <span className="inline-flex items-center gap-1 font-medium text-brand-600">Open<ArrowRight aria-hidden="true" className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {nextHref && (
        <div className="flex justify-end">
          <Link href={nextHref} className={buttonClasses({ variant: "secondary", className: "text-sm" })}>Older requests →</Link>
        </div>
      )}
    </div>
  );
}
