"use client";

import { useState } from "react";
import { formatIST } from "@/components/requests/status";
import { Button, Spinner } from "@/components/ui/button";
import { BuildingIcon, CheckIcon, InfoIcon, LockIcon, PhoneIcon } from "@/components/ui/icons";
import { requestApi } from "@/features/requests/api-client";
import type { DonorContactView, RequesterCoordinationView, TrackedRequestView } from "@/features/requests/types";

/**
 * Coordination on the tracking page. Institution answers and donor interest
 * are shown as what they are: "may be able to assist" isn't stock, and a
 * donor's interest isn't a donation. Donor contacts appear only on the
 * requester's private link, one at a time, and every reveal is logged.
 */

const PHASE: Record<string, string> = {
  running: "Contacting registered donors nearby, closest first",
  target_reached: "Enough donors have replied, so we've stopped contacting more for now",
  exhausted: "No more matching registered donors to contact nearby",
  stopped: "Donor contacting has stopped",
  pending: "Getting ready",
};
const AUTOMATION: Record<string, string> = { running: "In progress", paused: "Paused by the MarutiX team", cancelled: "Stopped by the MarutiX team", completed: "Finished" };
const COORD: Record<string, string> = {
  interested: "Interested",
  coordinator_contacted: "MarutiX coordinator contacted them",
  hospital_coordination: "Hospital is coordinating",
  donor_arrived: "Arrived at the blood centre",
  donation_confirmed: "Donation confirmed by the blood centre",
  not_proceeding: "Not proceeding",
};

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-brut-xs sm:p-6">
      <h2 className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Institutions({ items }: { items: RequesterCoordinationView["institutions"] }) {
  if (items.length === 0) return <p className="text-sm text-ink-muted">No hospitals or blood banks have been contacted yet.</p>;
  return (
    <ul className="divide-y divide-line text-sm">
      {items.map((i, index) => (
        <li key={`${i.name}-${index}`} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <span className="flex gap-2.5">
            <BuildingIcon className="mt-0.5 size-4 shrink-0 text-ink-muted" />
            <span>
              <span className="font-bold text-ink">{i.name}</span>
              <span className="block text-xs text-ink-muted">{i.type}{i.distanceKm !== null ? ` · about ${i.distanceKm} km` : ""}</span>
            </span>
          </span>
          <span className="pl-6 text-xs sm:pl-0 sm:text-right">
            {i.response ? (
              <span className={i.response.status === "can_assist" ? "font-semibold text-success-600" : "text-ink-soft"}>{i.response.label}<span className="block font-normal text-ink-muted">{formatIST(i.response.at)}</span></span>
            ) : (
              <span className="text-ink-muted">{i.contacted ? "Contacted, no reply yet" : "Not contacted yet"}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Donors({ view, token }: { view: TrackedRequestView; token: string }) {
  const donors = view.coordination!.donors!;
  const [revealed, setRevealed] = useState<Record<string, DonorContactView>>({});
  const [contacted, setContacted] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState<6 | 24 | 72>(24);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const shareable = donors.some((d) => d.contactAvailable);

  async function reveal(id: string) {
    setPending(id);
    setError(null);
    const result = await requestApi.revealDonor(token, view.publicRequestId, id);
    setPending(null);
    if (!result.ok) return setError(result.error.message);
    setRevealed((r) => ({ ...r, [id]: result.data }));
  }
  async function markContacted(id: string) {
    setPending(`c-${id}`);
    const result = await requestApi.markDonorContacted(token, view.publicRequestId, id);
    setPending(null);
    if (!result.ok) return setError(result.error.message);
    setContacted((c) => ({ ...c, [id]: true }));
  }
  async function share() {
    setPending("share");
    setError(null);
    const result = await requestApi.createContactLink(token, view.publicRequestId, hours);
    setPending(null);
    if (!result.ok) return setError(result.error.message);
    setLink(result.data);
  }

  return (
    <Card title="Donors who responded" note="A donor's interest isn't a donation. The blood centre checks every donor. Contact details appear only if the donor agreed to share them.">
      {donors.length === 0 ? (
        <p className="text-sm text-ink-muted">No donor has responded yet. You&apos;ll see them here, and on WhatsApp if you made the request there.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {donors.map((d) => {
            const contact = revealed[d.responseId];
            const done = contacted[d.responseId] || d.requesterContactedAt;
            return (
              <li key={d.responseId} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <span>
                    <span className="font-bold text-ink">{d.firstName}</span>
                    <span className="block text-xs text-ink-muted">Blood group {d.bloodGroup} (self-reported) · {d.area} · {d.response === "later" ? "May help later" : d.coordinationStatus ? COORD[d.coordinationStatus] : "Interested"}</span>
                  </span>
                  {d.contactAvailable ? (
                    contact ? (
                      <a href={`tel:${contact.phone}`} className="inline-flex min-h-11 items-center gap-1.5 font-bold text-ink underline decoration-brand-300 underline-offset-4"><PhoneIcon className="size-4" />{contact.phone}</a>
                    ) : (
                      <Button variant="secondary" className="h-9 px-3.5 text-sm" onClick={() => reveal(d.responseId)} disabled={pending !== null}>
                        {pending === d.responseId && <Spinner className="size-3.5" />}Show contact
                      </Button>
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-ink-muted"><LockIcon className="size-3.5" />Kept private; MarutiX will coordinate</span>
                  )}
                </div>
                {d.contactAvailable && (
                  <div className="mt-2">
                    {done ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-600"><CheckIcon className="size-3.5" />You contacted this donor</span>
                    ) : (
                      <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => markContacted(d.responseId)} disabled={pending !== null}>I&apos;ve contacted this donor</Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {shareable && (
        <div className="mt-5 border-t border-line pt-5">
          <h3 className="text-sm font-bold text-ink">Share donor contacts with one responsible person</h3>
          <p className="mt-1 text-xs text-ink-muted">For example a family member or the hospital coordinator. The link shows only these donors&apos; contacts, expires on its own, and every time it&apos;s opened is recorded.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="contact-hours" className="sr-only">Link lifetime</label>
            <select id="contact-hours" value={hours} onChange={(e) => setHours(Number(e.target.value) as 6 | 24 | 72)} className="h-11 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-ink shadow-brut-xs">
              <option value={6}>Valid for 6 hours</option>
              <option value={24}>Valid for 24 hours</option>
              <option value={72}>Valid for 3 days</option>
            </select>
            <Button variant="secondary" className="h-10 px-4 text-sm" onClick={share} disabled={pending !== null}>{pending === "share" && <Spinner />}Create contact link</Button>
          </div>
          {link && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input readOnly value={link.url} aria-label="Donor contact link" onFocus={(e) => e.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 font-mono text-xs" />
              <Button variant="secondary" className="h-10 px-4 text-sm" onClick={async () => { try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {} }}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 flex gap-2 text-sm font-semibold text-danger-600"><InfoIcon className="mt-px size-4 shrink-0" />{error}</p>}
    </Card>
  );
}

export function CoordinationSection({ view, token }: { view: TrackedRequestView; token: string }) {
  const c = view.coordination!;
  return (
    <div className="space-y-5">
      {c.automation && (
        <p className="flex gap-2.5 rounded-md border border-line bg-brand-50 px-4 py-3 text-sm leading-relaxed text-ink shadow-brut-xs">
          <InfoIcon className="mt-0.5 size-4.5 shrink-0" />
          <span>
            <strong>{AUTOMATION[c.automation.status] ?? c.automation.status}.</strong> {PHASE[c.automation.donorPhase] ?? ""}
            {c.automation.currentZone ? ` (now within ${c.automation.currentZone})` : ""}. {c.automation.donorsAlerted} donor alert{c.automation.donorsAlerted === 1 ? "" : "s"} sent so far.
          </span>
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Hospitals & blood banks" note="Contacted on your behalf. A reply that they may assist is not confirmed stock; please call them.">
          <Institutions items={c.institutions} />
        </Card>
        {c.donors ? (
          <Donors view={view} token={token} />
        ) : (
          <Card title="Donors">
            <p className="text-sm text-ink-soft">{c.donorCounts.interested} registered donor{c.donorCounts.interested === 1 ? " has" : "s have"} said they may be able to help. Details are visible to the requester only.</p>
          </Card>
        )}
      </div>
      {c.history.length > 0 && (
        <Card title="What MarutiX has done">
          <ol className="space-y-2.5 text-sm">
            {c.history.map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <span className="shrink-0 text-xs text-ink-muted sm:w-40">{formatIST(h.at)}</span>
                <span className="text-ink-soft">{h.summary}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

/** A donor-contacts link: only the consenting donors' contacts and the request basics. */
export function DonorContactsView({ view }: { view: TrackedRequestView }) {
  const contacts = view.donorContacts ?? [];
  return (
    <Card title="Donor contacts shared with you" note={`Shared by the requester for ${view.publicRequestId}. This link stops working on ${formatIST(view.link.expiresAt)}. Opening it is recorded.`}>
      {contacts.length === 0 ? (
        <p className="text-sm text-ink-muted">No donor has agreed to share their contact yet.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {contacts.map((d) => (
            <li key={d.responseId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span><span className="font-bold text-ink">{d.firstName}</span><span className="block text-xs text-ink-muted">Blood group {d.bloodGroup} (self-reported) · {d.area}</span></span>
              <a href={`tel:${d.phone}`} className="inline-flex min-h-11 items-center gap-1.5 font-bold text-ink underline decoration-brand-300 underline-offset-4"><PhoneIcon className="size-4" />{d.phone}</a>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-ink-muted">Please use these details only to coordinate this donation, and don&apos;t forward them. A donor&apos;s interest isn&apos;t a confirmed donation; the blood centre decides whether they can donate.</p>
    </Card>
  );
}
