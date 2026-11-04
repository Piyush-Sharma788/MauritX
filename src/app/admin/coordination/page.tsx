import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, EmptyState, PageHeader, Pill, Stat } from "@/components/admin/kit";
import { formatIST, StatusBadge } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { BLOOD_GROUP_LABELS, type BloodGroup } from "@/features/donors/schemas";
import { COMPONENT_LABELS, type Component } from "@/features/requests/schemas";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCoordinationOverview } from "@/server/admin/coordination";

export const metadata: Metadata = { title: "Coordination · Admin", robots: { index: false } };

export default function CoordinationPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12">
      <PageHeader eyebrow="Live" title="Emergency coordination" />
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <Overview />
      </Suspense>
    </div>
  );
}

const AUTOMATION_TONE: Record<string, "good" | "warn" | "bad" | "neutral" | "brand"> = { running: "brand", paused: "warn", cancelled: "bad", completed: "good" };

async function Overview() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") notFound();
  const { rows, totals } = await getCoordinationOverview();

  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="Open requests" value={rows.length} />
        <Stat label="Institutions found" value={totals.institutionsDiscovered} />
        <Stat label="Institutions contacted" value={totals.institutionsContacted} hint="message sent" />
        <Stat label="Institutions replied" value={totals.institutionsResponded} hint={`${totals.institutionsCanAssist} may assist (not stock)`} />
        <Stat label="Awaiting contact review" value={totals.outreachAwaitingReview} tone={totals.outreachAwaitingReview ? "warn" : "neutral"} />
        <Stat label="Failed messages" value={totals.failedMessages} tone={totals.failedMessages ? "bad" : "neutral"} />
        <Stat label="Donors matched" value={totals.donorsMatched} hint="latest search" />
        <Stat label="Donors notified" value={totals.donorsNotified} hint="sent to WhatsApp" />
        <Stat label="Donors interested" value={totals.donorsInterested} />
        <Stat label="Awaiting coordination" value={totals.awaitingCoordination} tone={totals.awaitingCoordination ? "warn" : "neutral"} hint="interested, not yet contacted" />
        <Stat label="Donations confirmed" value={totals.donationsConfirmed} tone="good" />
      </div>

      <Card title="Open requests" id="rows" note="Each column is a separate state: found ≠ contacted ≠ replied; notified ≠ interested ≠ donated.">
        {rows.length === 0 ? (
          <EmptyState>No open requests.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
                <tr>{["Request", "Need", "Automation", "Institutions found / contacted / replied", "Donors matched / notified / interested", "Awaiting", "Failed", "Donated"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.publicRequestId} className="align-top">
                    <td className="px-3 py-3">
                      <Link href={`/admin/requests/${r.publicRequestId}`} className="font-mono font-semibold text-brand-600">{r.publicRequestId}</Link>
                      <span className="mt-1 block"><StatusBadge status={r.status} /></span>
                    </td>
                    <td className="px-3 py-3 text-ink-soft">{r.bloodGroup === "unknown" ? "?" : BLOOD_GROUP_LABELS[r.bloodGroup as BloodGroup]} · {r.unitsRequested} × {COMPONENT_LABELS[r.component as Component]}<span className="block text-xs text-ink-muted">{r.city} · by {formatIST(r.requiredBy)}</span></td>
                    <td className="px-3 py-3"><Pill tone={AUTOMATION_TONE[r.automation] ?? "neutral"}>{r.automation.replace(/_/g, " ")}</Pill><span className="mt-1 block text-xs text-ink-muted">{r.donorPhase.replace(/_/g, " ")}{r.currentZone ? ` · ${r.currentZone}` : ""}</span></td>
                    <td className="px-3 py-3 tabular-nums">{r.institutionsDiscovered} / {r.institutionsContacted} / {r.institutionsResponded}{r.institutionsCanAssist ? <span className="block text-xs text-success-600">{r.institutionsCanAssist} may assist</span> : null}{r.outreachAwaitingReview ? <span className="block text-xs text-warning-800">{r.outreachAwaitingReview} awaiting review</span> : null}</td>
                    <td className="px-3 py-3 tabular-nums">{r.donorsMatched} / {r.donorsNotified} / {r.donorsInterested}</td>
                    <td className="px-3 py-3 tabular-nums">{r.awaitingCoordination}</td>
                    <td className={`px-3 py-3 tabular-nums ${r.failedMessages ? "text-danger-600" : ""}`}>{r.failedMessages}</td>
                    <td className="px-3 py-3 tabular-nums">{r.donationsConfirmed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
