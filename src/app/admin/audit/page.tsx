import type { Metadata } from "next";
import Link from "next/link";

import { Suspense } from "react";
import { z } from "zod";
import { Card, EmptyState, PageHeader, Pill } from "@/components/admin/kit";
import { formatIST } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/form";
import { requireAdminPage } from "@/lib/auth/require-admin";
import { listAuditEvents } from "@/server/admin/operations";
import { AUDIT_ACTIONS } from "@/server/models/audit-log";

export const metadata: Metadata = { title: "Audit · Admin", robots: { index: false } };

const filtersSchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional().catch(undefined),
  cursor: z.string().regex(/^[a-f0-9]{24}$/).optional().catch(undefined),
});

export default function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <PageHeader eyebrow="Security" title="Audit history" />
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <AuditContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function AuditContent({ searchParams }: Pick<PageProps<"/admin/audit">, "searchParams">) {
  await requireAdminPage("audit.read");
  const raw = Object.fromEntries(Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" && v ? [[k, v]] : [])));
  const filters = filtersSchema.parse(raw);
  const { events, nextCursor } = await listAuditEvents(filters);

  return (
    <div className="mt-8 space-y-5">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-soft">
        <label className="min-w-64 flex-1 text-xs font-semibold text-ink-soft">Action
          <select name="action" defaultValue={filters.action ?? ""} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <button type="submit" className="h-11 rounded-full bg-ink px-5 text-sm font-semibold text-white hover:bg-ink/90">Filter</button>
        {filters.action && <Link href="/admin/audit" className="h-11 rounded-full px-4 py-3 text-sm font-medium text-ink-soft hover:bg-ink/5">Reset</Link>}
      </form>
      <Card title="Events" id="events" note="Append-only. Never contains OTPs, tokens, full phone numbers or message text.">
        {events.length === 0 ? (
          <EmptyState>No events.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
                <tr>{["When", "Action", "Outcome", "Actor", "Resource"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-soft">{formatIST(e.createdAt)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-ink">{e.action}</td>
                    <td className="px-3 py-2"><Pill tone={e.outcome === "success" ? "good" : "bad"}>{e.outcome}</Pill></td>
                    <td className="px-3 py-2 text-ink-soft">{e.actor ?? "system"}</td>
                    <td className="max-w-72 truncate px-3 py-2 font-mono text-xs text-ink-muted" title={e.resourceId ?? undefined}>{[e.resourceType, e.resourceId].filter(Boolean).join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {nextCursor && (
        <div className="flex justify-end">
          <Link href={`/admin/audit?${new URLSearchParams({ ...raw, cursor: nextCursor }).toString()}`} className="rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink hover:bg-paper-deep">Older events →</Link>
        </div>
      )}
    </div>
  );
}
