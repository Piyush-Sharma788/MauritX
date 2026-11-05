"use client";

import { useState, type ReactNode } from "react";
import { StatusBadge, StatusTimeline, formatIST } from "@/components/requests/status";
import { Button, Spinner } from "@/components/ui/button";
import { Notice } from "@/components/ui/primitives";
import { CheckIcon, InfoIcon, PhoneIcon } from "@/components/ui/icons";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import { requestApi } from "@/features/requests/api-client";
import { COMPONENT_LABELS, PRIORITY_LABELS, type RequestStatus } from "@/features/requests/schemas";
import type { TrackedRequestView } from "@/features/requests/types";
import { CoordinationSection, DonorContactsView } from "@/components/requests/coordination-section";

const SAFETY =
  "MarutiX helps coordinate contacts. It does not guarantee donor eligibility, blood availability or compatibility. Contact the treating hospital/blood centre immediately; do not delay urgent medical care while using this app.";

function VerificationBanner({ view }: { view: TrackedRequestView }) {
  if (view.status === "pending_verification") {
    return (
      <Notice tone="warn" as="p">
        <span><strong>Not yet verified.</strong> The MarutiX team is verifying this request with the hospital. Until then, treat these details as unconfirmed.</span>
      </Notice>
    );
  }
  if (view.verifiedAt) {
    return (
      <Notice tone="shield" as="p">
        <span><strong>Verified by MarutiX</strong> with the hospital on {formatIST(view.verifiedAt)}. Availability is still not guaranteed.</span>
      </Notice>
    );
  }
  return null;
}

/** `nearby`: server-rendered nearby blood banks and hospitals, shown before the manage controls. */
export function TrackedRequest({ initial, token, nearby }: { initial: TrackedRequestView; token: string; nearby?: ReactNode }) {
  const [view, setView] = useState(initial);
  return (
    <div className="space-y-5">
      <header className="relative overflow-hidden rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut-lg sm:p-8">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-2 bg-stripes" />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge status={view.status} />
          <span className={`rounded-sm border-2 border-ink px-1.5 py-px font-mono text-[0.66rem] font-bold uppercase tracking-[0.08em] ${view.priority === "critical" ? "bg-danger-50 text-danger-600" : "bg-paper-deep text-ink-soft"}`}>
            {PRIORITY_LABELS[view.priority].label}
          </span>
        </div>
        <h1 className="mt-4 font-display text-[2.4rem] font-extrabold leading-[0.98] tracking-[-0.05em] text-ink sm:text-6xl">
          {view.bloodGroup === "unknown" ? "Blood" : BLOOD_GROUP_LABELS[view.bloodGroup]} · {view.unitsRequested} {view.unitsRequested === 1 ? "unit" : "units"}
        </h1>
        <p className="mt-2 text-lg text-ink-soft">{COMPONENT_LABELS[view.component]} · needed by {formatIST(view.requiredBy)}</p>
        <p className="mt-4 text-sm text-ink-muted">
          Request <span className="rounded-sm border-2 border-ink bg-signal-300 px-1.5 font-mono font-bold text-ink">{view.publicRequestId}</span> · created {formatIST(view.createdAt)}
        </p>
        <div className="mt-5">
          <VerificationBanner view={view} />
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut">
          <h2 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">Hospital</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{view.verifiedAt ? "Confirmed during MarutiX verification." : "As entered by the requester; not yet verified."}</p>
          <dl className="mt-4 space-y-3 text-sm [&_dd]:mt-0.5 [&_dt]:font-mono [&_dt]:text-[0.66rem] [&_dt]:font-bold [&_dt]:uppercase [&_dt]:tracking-[0.1em]">
            <div><dt className="text-ink-muted">Name</dt><dd className="font-bold text-ink">{view.hospital.name}</dd></div>
            <div><dt className="text-ink-muted">Address</dt><dd className="font-bold text-ink">{view.hospital.address}, {view.hospital.locality}, {view.hospital.city}</dd></div>
            {view.hospital.phone && (
              <div>
                <dt className="text-ink-muted">Phone</dt>
                <dd><a href={`tel:${view.hospital.phone.replace(/[^\d+]/g, "")}`} className="inline-flex min-h-11 items-center gap-1.5 font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-4"><PhoneIcon className="size-4" />{view.hospital.phone}</a></dd>
              </div>
            )}
          </dl>
        </section>
        <section className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut">
          <h2 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">Status history</h2>
          <div className="mt-5">
            <StatusTimeline history={view.history} />
          </div>
        </section>
      </div>

      {view.donorContacts && <DonorContactsView view={view} />}
      {view.coordination && <CoordinationSection view={view} token={token} />}
      {nearby}

      {view.donorContacts ? null : view.manage ? <ManagePanel view={view} token={token} onChange={setView} /> : (
        <Notice as="p" tone="info">
          View-only link. It stops working on {formatIST(view.link.expiresAt)}.
        </Notice>
      )}

      <Notice tone="warn" size="sm" as="p">
        {SAFETY} In a life-threatening emergency, call <a href="tel:112" className="font-bold underline decoration-2 underline-offset-2">112</a>.
      </Notice>
    </div>
  );
}

const ACTIONS: Partial<Record<RequestStatus, { label: string; variant: "primary" | "secondary" | "danger" }>> = {
  fulfilled: { label: "We got the blood (fulfilled)", variant: "primary" },
  partially_fulfilled: { label: "Some units arranged", variant: "secondary" },
  cancelled: { label: "Cancel request", variant: "danger" },
};

function ManagePanel({ view, token, onChange }: { view: TrackedRequestView; token: string; onChange: (v: TrackedRequestView) => void }) {
  const manage = view.manage!;
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RequestStatus | null>(null);
  const [hours, setHours] = useState<24 | 72 | 168>(72);
  const [newLink, setNewLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function setStatus(status: "partially_fulfilled" | "fulfilled" | "cancelled") {
    setPending(status);
    setError(null);
    const result = await requestApi.setStatus(token, view.publicRequestId, status);
    setPending(null);
    setConfirm(null);
    if (result.ok) onChange(result.data);
    else setError(result.error.message);
  }

  async function refresh() {
    const response = await fetch(`/api/v1/requests/${view.publicRequestId}`, { headers: { "X-Tracking-Token": token }, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.data) onChange(payload.data);
  }

  async function createLink() {
    setPending("link");
    setError(null);
    const result = await requestApi.createFamilyLink(token, view.publicRequestId, hours);
    setPending(null);
    if (!result.ok) return setError(result.error.message);
    setNewLink(result.data);
    await refresh();
  }

  async function revoke(linkId: string) {
    setPending(`revoke-${linkId}`);
    const result = await requestApi.revokeFamilyLink(token, view.publicRequestId, linkId);
    setPending(null);
    if (!result.ok) return setError(result.error.message);
    await refresh();
  }

  const statuses = manage.allowedStatuses.filter((s) => ACTIONS[s]) as ("partially_fulfilled" | "fulfilled" | "cancelled")[];

  return (
    <section className="rounded-[var(--radius-card)] border-2 border-ink bg-brand-50 p-6 shadow-brut sm:p-7">
      <h2 className="font-display text-2xl font-extrabold tracking-[-0.03em] text-ink">Manage your request</h2>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        This is your private link (contact {manage.contactMaskedPhone}). Anyone with it can update or cancel the request. It stops working on {formatIST(view.link.expiresAt)}.
      </p>

      {statuses.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {statuses.map((s) => (
            <Button key={s} variant={ACTIONS[s]!.variant} onClick={() => setConfirm(s)} disabled={pending !== null}>
              {ACTIONS[s]!.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-5 flex items-center gap-2 text-sm font-medium text-ink-soft">
          <CheckIcon className="size-4" /> This request is closed and can no longer be changed.
        </p>
      )}

      {confirm && (
        <div role="alertdialog" aria-labelledby="confirm-status" className="animate-rise mt-4 rounded-md border-2 border-ink bg-signal-50 p-4 text-sm shadow-brut-sm">
          <p id="confirm-status" className="font-bold text-ink">
            {confirm === "cancelled" ? "Cancel this request?" : confirm === "fulfilled" ? "Mark this request as fulfilled?" : "Report that some units are arranged?"}
          </p>
          <p className="mt-1 text-ink-soft">{confirm === "partially_fulfilled" ? "The request stays open for the remaining units." : "This closes the request. It can't be reopened."}</p>
          <div className="mt-3 flex gap-2">
            <Button variant={confirm === "cancelled" ? "danger-solid" : "primary"} className="h-10 px-4 text-sm" onClick={() => setStatus(confirm as "partially_fulfilled" | "fulfilled" | "cancelled")} disabled={pending !== null}>
              {pending && <Spinner />}Yes, confirm
            </Button>
            <Button variant="ghost" className="h-10 px-4 text-sm" onClick={() => setConfirm(null)} disabled={pending !== null}>Not now</Button>
          </div>
        </div>
      )}

      <div className="mt-6 border-t-2 border-ink pt-5">
        <h3 className="text-sm font-bold text-ink">Share a view-only link with family</h3>
        <p className="mt-1 text-xs text-ink-muted">They&apos;ll see the status and hospital, but can&apos;t change anything.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="link-hours" className="sr-only">Link lifetime</label>
          <select id="link-hours" value={hours} onChange={(e) => setHours(Number(e.target.value) as 24 | 72 | 168)} className="h-11 rounded-md border-2 border-ink bg-surface px-3 text-sm font-semibold text-ink shadow-brut-xs">
            <option value={24}>Valid for 24 hours</option>
            <option value={72}>Valid for 3 days</option>
            <option value={168}>Valid for 7 days</option>
          </select>
          <Button variant="secondary" className="h-10 px-4 text-sm" onClick={createLink} disabled={pending !== null}>
            {pending === "link" && <Spinner />}Create link
          </Button>
        </div>
        {newLink && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input readOnly value={newLink.url} aria-label="View-only link" onFocus={(e) => e.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-md border-2 border-ink bg-surface px-3 font-mono text-xs" />
            <Button variant="secondary" className="h-10 px-4 text-sm" onClick={async () => { try { await navigator.clipboard.writeText(newLink.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {} }}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
        {manage.shareLinks.length > 0 && (
          <ul className="mt-4 divide-y divide-line text-sm">
            {manage.shareLinks.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-ink-soft">
                  {l.scope === "donor_contacts" ? "Donor contact link" : "View-only link"} · created {formatIST(l.createdAt)} · {l.revoked ? "turned off" : new Date(l.expiresAt) < new Date() ? "expired" : `expires ${formatIST(l.expiresAt)}`}
                </span>
                {!l.revoked && new Date(l.expiresAt) > new Date() && (
                  <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => revoke(l.id)} disabled={pending !== null}>Turn off</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-4 flex gap-2 text-sm font-semibold text-danger-600"><InfoIcon className="mt-px size-4 shrink-0" />{error}</p>
      )}
    </section>
  );
}
