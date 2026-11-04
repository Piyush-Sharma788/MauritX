import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { CoordinationPanel } from "@/components/admin/coordination-panel";
import { RequestStatusActions, RevokeLinkButton } from "@/components/admin/request-actions";
import { StatusBadge, StatusTimeline, formatIST } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { ArrowLeftIcon, LockIcon, ShieldIcon } from "@/components/ui/icons";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import { COMPONENT_LABELS, PRIORITY_LABELS, publicRequestIdSchema } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import { getCurrentUser } from "@/lib/auth/current-user";
import { maskPhone } from "@/lib/validation/phone";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { getRequestCoordination } from "@/server/coordination/admin";
import { listInstitutions } from "@/server/institutions/service";
import { getAdminRequestDetail } from "@/server/requests/service";

export const metadata: Metadata = { title: "Request · Admin", robots: { index: false } };

export default function AdminRequestDetailPage({ params }: PageProps<"/admin/requests/[publicRequestId]">) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/admin/requests" className="-ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-ink-soft hover:bg-ink/5 hover:text-ink">
        <ArrowLeftIcon className="size-4" /> All requests
      </Link>
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <DetailContent params={params} />
      </Suspense>
    </div>
  );
}

function Card({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-soft">
      <h2 className="font-semibold text-ink">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:justify-between sm:gap-4">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="font-medium text-ink sm:text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

async function DetailContent({ params }: Pick<PageProps<"/admin/requests/[publicRequestId]">, "params">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") notFound();
  const parsed = publicRequestIdSchema.safeParse((await params).publicRequestId);
  if (!parsed.success) notFound();

  let r;
  try {
    r = await getAdminRequestDetail(parsed.data, new Types.ObjectId(user.id), { requestId: randomUUID() });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const [coordination, institutions] = await Promise.all([getRequestCoordination(r.publicRequestId), listInstitutions({ status: "verified" })]);

  return (
    <div className="mt-4 space-y-5">
      <header className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-soft sm:flex-row sm:items-start sm:justify-between sm:p-8">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.status} className="text-sm" />
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${r.priority === "critical" ? "bg-danger-50 text-danger-600" : "bg-paper-deep text-ink-soft"}`}>{PRIORITY_LABELS[r.priority].label}</span>
          </div>
          <h1 className="mt-3 font-mono text-2xl font-bold text-ink sm:text-3xl">{r.publicRequestId}</h1>
          <p className="mt-1 text-ink-soft">
            {r.bloodGroup === "unknown" ? "Blood group not known" : BLOOD_GROUP_LABELS[r.bloodGroup]} · {r.unitsRequested} × {COMPONENT_LABELS[r.component]} · needed by {formatIST(r.requiredBy)}
          </p>
          <p className="mt-1 text-xs text-ink-muted">Created {formatIST(r.createdAt)} · expires {formatIST(r.expiresAt)}</p>
        </div>
        {r.verifiedAt && (
          <p className="inline-flex items-center gap-1.5 self-start rounded-full bg-success-50 px-3 py-1 text-xs font-semibold text-success-600">
            <ShieldIcon className="size-3.5" /> Verified {formatIST(r.verifiedAt)}
          </p>
        )}
      </header>

      <Card title="Update status" note="Verify only after confirming with the hospital or blood bank. Changes are recorded in the history and audit log.">
        <RequestStatusActions publicRequestId={r.publicRequestId} allowed={r.allowedStatuses} />
      </Card>

      <Card title="Donor coordination" note="Alerts go only to consenting donors, in small batches you send yourself, and only while the request is active.">
        <CoordinationPanel
          publicRequestId={r.publicRequestId}
          summary={coordination.summary}
          latestRun={coordination.latestRun}
          responses={coordination.responses}
          institutions={institutions.map((i) => ({ id: i.id, displayName: i.displayName, city: i.city }))}
          batchSize={getCoordinationConfig().alertBatchSize}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Patient & contact" note={<span className="inline-flex items-center gap-1"><LockIcon className="size-3.5" /> Visible to admins only. This view is audit-logged.</span>}>
          <Rows rows={[
            ["Patient", `${r.patientName}${r.patientAge !== null ? `, ${r.patientAge} yrs` : ""}`],
            ["Contact person", r.contactName],
            ["Contact mobile", <a key="tel" href={`tel:${r.contactPhone}`} className="text-brand-600">{maskPhone(r.contactPhone)} · tap to call</a>],
            ["WhatsApp updates", r.whatsappUpdates ? "Requested" : "Not requested"],
            ["Consent", `${formatIST(r.consentAcceptedAt)} · notice ${r.privacyNoticeVersion}`],
          ]} />
        </Card>
        <Card title="Hospital" note={r.verifiedAt ? "Confirmed during verification." : "As entered by the requester. Not yet verified."}>
          <Rows rows={[
            ["Name", r.hospitalName],
            ["Address", `${r.hospitalAddress}, ${r.locality}, ${r.city}`],
            ["Phone", r.hospitalPhone ? <a key="h" href={`tel:${r.hospitalPhone.replace(/[^\d+]/g, "")}`} className="text-brand-600">{r.hospitalPhone}</a> : "Not provided"],
            ["Requester's device location", r.location ? `${r.location.latitude}, ${r.location.longitude} (approximate, ~100 m)` : "Not shared"],
          ]} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <Card title="Status history" note="Notes are internal and never shown on tracking links.">
          <StatusTimeline history={r.history} />
        </Card>
        <Card title="Tracking links" note="Tokens are never stored; only their hashes. Turn off any link that may have been shared too widely.">
          {r.links.length === 0 ? <p className="text-sm text-ink-muted">No links.</p> : (
            <ul className="divide-y divide-line text-sm">
              {r.links.map((l) => {
                const live = !l.revoked && new Date(l.expiresAt) > new Date();
                return (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span>
                      <span className="font-medium text-ink">{l.scope === "manage" ? "Manage link" : "View-only link"}</span>
                      <span className="block text-xs text-ink-muted">by {l.createdBy} · {l.revoked ? "turned off" : live ? `expires ${formatIST(l.expiresAt)}` : "expired"}</span>
                    </span>
                    {live && <RevokeLinkButton publicRequestId={r.publicRequestId} linkId={l.id} />}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
