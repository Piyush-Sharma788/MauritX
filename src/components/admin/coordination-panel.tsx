"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionButton } from "@/components/admin/action-button";
import { Button, Spinner } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { inputClasses } from "@/components/ui/form";
import { coordinationApi } from "@/features/coordination/api-client";
import { COORDINATION_LABELS, RADIUS_OPTIONS_KM, type CoordinationStatus, type RadiusKm } from "@/features/coordination/schemas";
import type { AlertBatchResult, CoordinationSummary, MatchingRunView, ResponseView } from "@/features/coordination/types";

const EXCLUSION_LABELS: Record<string, string> = {
  duplicate: "Duplicate record",
  requester_self: "The requester",
  account_inactive: "Account not active",
  opted_out: "Opted out (STOP)",
  no_alert_consent: "No alert consent",
  alerts_paused: "Alerts paused",
  not_available: "Marked unavailable",
  donor_blood_group_unknown: "Blood group not known",
  blood_group_not_matched: "Blood group not in policy",
  recent_donation: "Donated recently",
  outside_radius: "Outside radius",
  different_city: "Different city, no location",
  already_contacted: "Already alerted or replied",
  over_candidate_limit: "Over the candidate limit",
};

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const when = (iso: string) => `${fmt.format(new Date(iso))} IST`;

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="border-t border-line pt-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function CoordinationPanel({
  publicRequestId,
  summary,
  latestRun,
  responses,
  institutions,
  batchSize,
}: {
  publicRequestId: string;
  summary: CoordinationSummary;
  latestRun: MatchingRunView | null;
  responses: ResponseView[];
  institutions: { id: string; displayName: string; city: string }[];
  batchSize: number;
}) {
  const router = useRouter();
  const [radius, setRadius] = useState<RadiusKm>(latestRun ? (latestRun.radiusKm as RadiusKm) : 10);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<AlertBatchResult | null>(null);
  const [institutionId, setInstitutionId] = useState(summary.institution?.id ?? "");

  async function search() {
    setSearching(true);
    setError(null);
    setBatch(null);
    const result = await coordinationApi.runMatching(publicRequestId, radius);
    setSearching(false);
    if (!result.ok) return setError(result.error.message);
    router.refresh();
  }

  const pending = latestRun?.candidates.filter((c) => !c.alertStatus) ?? [];
  const a = summary.alerts;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4 lg:grid-cols-8">
        {[
          ["Queued", a.queued],
          ["Sent", a.sent],
          ["Delivered", a.delivered],
          ["Read", a.read],
          ["Failed", a.failed],
          ["Suppressed", a.suppressed],
          ["Interested", summary.interested],
          ["Donations confirmed", summary.donationsConfirmed],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-paper-deep/60 px-2 py-2">
            <p className="font-display text-lg font-bold text-ink tabular-nums">{value}</p>
            <p className="text-ink-muted">{label}</p>
          </div>
        ))}
      </div>

      <Section title="Coordinating institution" note="Verified institutions only. Their verified contacts can see this request on WhatsApp, acknowledge it, and (coordinators) report fulfilment.">
        <div className="flex flex-wrap items-center gap-2">
          <select value={institutionId} onChange={(e) => setInstitutionId(e.target.value)} className={`${inputClasses} h-10 max-w-sm border-line-strong text-sm`} aria-label="Institution">
            <option value="">None linked</option>
            {institutions.map((i) => <option key={i.id} value={i.id}>{i.displayName} ({i.city})</option>)}
          </select>
          <ActionButton
            label="Save"
            className="h-10 px-4 text-sm"
            action={() => coordinationApi.linkInstitution(publicRequestId, institutionId || null)}
          />
          {summary.institution && (
            <span className="text-xs text-ink-muted">{summary.institution.acknowledgedAt ? `Acknowledged ${when(summary.institution.acknowledgedAt)}` : "Not acknowledged yet"}</span>
          )}
        </div>
      </Section>

      <Section
        title="Find potential donors"
        note="Deterministic and explainable. This finds people to contact, not medically approved donors: the blood centre decides eligibility and compatibility."
      >
        {!summary.alertable ? (
          <p className="flex gap-2 rounded-xl bg-warning-50 px-3 py-2 text-sm text-warning-800"><InfoIcon className="mt-0.5 size-4 shrink-0" />Donor search and alerts open once the request is verified and marked active.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-soft">Within</span>
            {RADIUS_OPTIONS_KM.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRadius(r)}
                aria-pressed={radius === r}
                className={`h-9 rounded-full px-3.5 text-sm font-semibold ring-1 transition ${radius === r ? "bg-ink text-white ring-ink" : "bg-surface text-ink ring-line-strong hover:bg-paper-deep"}`}
              >
                {r} km
              </button>
            ))}
            <Button className="h-9 px-4 text-sm" onClick={search} disabled={searching}>{searching && <Spinner className="size-3.5" />}Search</Button>
          </div>
        )}
        {error && <p role="alert" className="mt-2 flex gap-1.5 text-sm text-danger-600"><InfoIcon className="mt-0.5 size-4 shrink-0" />{error}</p>}

        {latestRun && (
          <div className="mt-4 rounded-2xl border border-line">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 text-xs text-ink-muted">
              <span>
                Search {when(latestRun.createdAt)} · {latestRun.basis === "distance" ? `within ${latestRun.radiusKm} km of the ${latestRun.originSource === "institution" ? "linked institution" : "requester's shared location"}` : "same city (no location on the request)"} · {latestRun.scanned} profiles checked · groups {latestRun.eligibleGroups.join(", ") || "none"}
              </span>
              <span className="rounded-full bg-warning-50 px-2 py-0.5 font-semibold text-warning-800">Policy {latestRun.policyVersion}: {latestRun.policyReviewStatus.replace(/_/g, " ")}</span>
            </div>
            {latestRun.candidates.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-muted">No potential donors match. Try a wider radius, and keep working directly with the hospital&apos;s blood bank.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-ink-muted">
                    <tr>{["#", "Donor", "Distance", "Why", "Alert", "Reply"].map((h) => <th key={h} scope="col" className="px-4 py-2 font-semibold">{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {latestRun.candidates.map((c) => (
                      <tr key={c.rank}>
                        <td className="px-4 py-2 tabular-nums text-ink-muted">{c.rank}</td>
                        <td className="px-4 py-2 font-medium text-ink">{c.donorFirstName}</td>
                        <td className="px-4 py-2 text-ink-soft">{c.distanceKm !== null ? `${c.distanceKm} km` : "Same city"}</td>
                        <td className="px-4 py-2 text-xs text-ink-muted">
                          <details><summary className="cursor-pointer text-brand-600">Reasons</summary><ul className="mt-1 list-disc pl-4">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul></details>
                        </td>
                        <td className="px-4 py-2 text-xs text-ink-soft">{c.alertStatus ?? "Not sent"}</td>
                        <td className="px-4 py-2 text-xs text-ink-soft">{c.response ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {Object.keys(latestRun.excluded).length > 0 && (
              <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
                Excluded: {Object.entries(latestRun.excluded).map(([k, v]) => `${EXCLUSION_LABELS[k] ?? k} ${v}`).join(" · ")}
              </p>
            )}
            {summary.alertable && pending.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                <ActionButton
                  label={`Send alerts to the next ${Math.min(batchSize, pending.length)}`}
                  variant="primary"
                  confirm={summary.alertsPaused ? "Alerts are paused on the Operations page." : `Alert the next ${Math.min(batchSize, pending.length)} potential donors on WhatsApp? Consent is re-checked before each message.`}
                  action={() => coordinationApi.sendBatch(publicRequestId, latestRun.id)}
                  onDone={(data) => setBatch(data as AlertBatchResult)}
                />
                <span className="text-xs text-ink-muted">{pending.length} not yet alerted. No patient or contact details are included in alerts.</span>
              </div>
            )}
            {batch && (
              <p role="status" className="border-t border-line px-4 py-3 text-sm text-ink">
                Queued {batch.queued}{batch.suppressed ? `, skipped ${batch.suppressed} (consent or limits)` : ""}{batch.duplicates ? `, ${batch.duplicates} already alerted` : ""}. Delivery depends on WhatsApp and isn&apos;t guaranteed.
              </p>
            )}
          </div>
        )}
      </Section>

      <Section title="Donor responses" note="Phone numbers appear only when the donor agreed to share them for this request. Only you or the coordinating institution move a response forward.">
        {responses.length === 0 ? (
          <p className="text-sm text-ink-muted">No responses yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {responses.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <span>
                  <span className="font-medium text-ink">{r.donorFirstName}</span>{" "}
                  <span className="text-xs text-ink-muted">· {r.response === "interested" ? "interested" : "unavailable"} · {when(r.respondedAt)}</span>
                  <span className="block text-xs text-ink-muted">
                    {r.donorPhone ? <a href={`tel:${r.donorPhone}`} className="font-semibold text-brand-600">{r.donorPhone}</a> : r.contactSharing === "declined" ? "Chose not to share contact" : "Contact sharing not answered"}
                    {r.coordinationStatus && <> · {COORDINATION_LABELS[r.coordinationStatus]}</>}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {r.allowedNext.map((next: CoordinationStatus) => (
                    <ActionButton
                      key={next}
                      label={COORDINATION_LABELS[next]}
                      variant={next === "not_proceeding" ? "ghost" : next === "donation_confirmed" ? "primary" : "secondary"}
                      className="h-8 px-3 text-xs"
                      confirm={next === "donation_confirmed" ? "Only confirm after the blood centre reports the donation." : undefined}
                      action={() => coordinationApi.updateResponse(publicRequestId, r.id, next)}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
