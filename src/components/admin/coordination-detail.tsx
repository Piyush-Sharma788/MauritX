import Link from "next/link";
import { AutomationControls, OutreachActions } from "@/components/admin/coordination-actions";
import { Card, EmptyState, Pill } from "@/components/admin/kit";
import { formatIST } from "@/components/requests/status";
import { CAPABILITY_LABELS, INSTITUTION_RESPONSE_LABELS, OUTREACH_STATUS_LABELS } from "@/features/coordination/schemas";
import type { RequestCoordination } from "@/server/coordination/admin";

/** Phase 6 sections of the admin request page. Server-rendered; actions are client components. */

const PHASE: Record<string, string> = { pending: "Not started", running: "Running", target_reached: "Enough donors interested", exhausted: "No more matching donors", stopped: "Stopped" };
const TONE: Record<string, "good" | "warn" | "bad" | "neutral" | "brand"> = { running: "brand", paused: "warn", cancelled: "bad", completed: "good", not_started: "neutral" };
const OUTREACH_TONE: Record<string, "good" | "warn" | "bad" | "neutral" | "brand"> = { sent: "good", partially_sent: "good", queued: "brand", awaiting_review: "warn", failed: "bad", no_contact: "neutral", channel_unavailable: "warn", excluded: "neutral", cancelled: "neutral" };

export function AutomationCard({ publicRequestId, c }: { publicRequestId: string; c: RequestCoordination }) {
  const a = c.automation;
  return (
    <Card
      title="Automated coordination"
      id="automation"
      note={`Starts when the request is activated. Donor zones: ${a.zonesKm.map((z, i) => `${i === 0 ? 0 : a.zonesKm[i - 1]}–${z} km`).join(", ")}, then same city. Waves stop once ${a.targetInterested} donors are interested.`}
      actions={<AutomationControls publicRequestId={publicRequestId} status={a.status} alertable={c.summary.alertable} />}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill tone={TONE[a.status] ?? "neutral"}>{a.status.replace(/_/g, " ")}</Pill>
        <span className="text-ink-soft">Donors: {PHASE[a.donorPhase] ?? a.donorPhase}{a.currentZone ? ` · zone ${a.currentZone}` : ""}</span>
        <span className="text-ink-soft">· Discovery: {a.discoveryStatus}{a.discoveredAt ? ` (${formatIST(a.discoveredAt)})` : ""}{a.geocoded ? " · search centre geocoded from the address (approximate)" : ""}</span>
        {a.nextWaveAt && a.status === "running" && <span className="text-ink-muted">· next wave {formatIST(a.nextWaveAt)}</span>}
        {c.summary.alertsPaused && <Pill tone="warn">All alerts paused (Operations)</Pill>}
      </div>
      {a.waves.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">No donor waves yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-muted"><tr>{["Wave", "Zone", "Alerts queued", "Skipped (consent / limits)", "When"].map((h) => <th key={h} scope="col" className="py-2 pr-4 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {a.waves.map((w) => (
                <tr key={w.number}><td className="py-2 pr-4 tabular-nums">{w.number}</td><td className="py-2 pr-4">{w.zone}</td><td className="py-2 pr-4 tabular-nums">{w.queued}</td><td className="py-2 pr-4 tabular-nums">{w.suppressed}</td><td className="py-2 pr-4 text-ink-muted">{formatIST(w.at)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function OutreachCard({ publicRequestId, c }: { publicRequestId: string; c: RequestCoordination }) {
  return (
    <Card
      title="Hospitals & blood banks"
      id="outreach"
      note="Discovered records are unverified. Unreviewed email addresses are used only after an admin approves the institution. 'Sent' is delivery to the mail server, not a reply, and a reply is not confirmed stock. Place data © OpenStreetMap contributors (ODbL)."
    >
      {c.outreach.length === 0 ? (
        <EmptyState>No institutions found for this request yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {c.outreach.map((o) => (
            <li key={o.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <span>
                  <Link href={`/admin/institutions/${o.institutionId}`} className="font-semibold text-brand-600 hover:text-brand-700">{o.name}</Link>{" "}
                  <span className="text-xs text-ink-muted">· {CAPABILITY_LABELS[o.capability]} · {o.distanceKm !== null ? `${o.distanceKm} km` : "distance unknown"} · {o.source === "openstreetmap" ? "discovered (OpenStreetMap)" : "added by admin"} · review: {o.reviewStatus}{o.verificationStatus === "verified" ? " · verified institution" : ""}</span>
                </span>
                <Pill tone={OUTREACH_TONE[o.status] ?? "neutral"}>{OUTREACH_STATUS_LABELS[o.status]}</Pill>
              </div>
              <p className="text-xs text-ink-muted">
                Contacts: {o.channels.length === 0 ? "none recorded" : o.channels.map((ch) => `${ch.type} ${ch.value} (${ch.status}, ${ch.source.replace("_", " ")})`).join(" · ")}
              </p>
              {o.deliveries.length > 0 && (
                <p className="text-xs text-ink-muted">Deliveries: {o.deliveries.map((d) => `${d.channel} → ${d.target}: ${d.status}${d.failureCode ? ` (${d.failureCode})` : ""}${d.sentAt ? ` ${formatIST(d.sentAt)}` : ""}`).join(" · ")}</p>
              )}
              {o.response && (
                <p className={`text-xs ${o.response.status === "can_assist" ? "font-semibold text-success-600" : "text-ink-soft"}`}>
                  Answer ({o.response.source.replace("_", " ")}, {formatIST(o.response.at)}): {INSTITUTION_RESPONSE_LABELS[o.response.status]}
                  {o.response.contactName || o.response.contactPhone ? ` · ${[o.response.contactName, o.response.contactPhone].filter(Boolean).join(", ")}` : ""}
                  {o.response.note ? ` · “${o.response.note}”` : ""}
                </p>
              )}
              <OutreachActions publicRequestId={publicRequestId} outreachId={o.id} status={o.status} alertable={c.summary.alertable} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function HistoryCard({ c }: { c: RequestCoordination }) {
  return (
    <Card title="Coordination history" id="history" note={`Newest first. Donor contact disclosures recorded: ${c.contactAccessEvents}.`}>
      {c.events.length === 0 ? (
        <EmptyState>Nothing yet.</EmptyState>
      ) : (
        <ol className="max-h-96 space-y-2 overflow-y-auto text-sm">
          {c.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="shrink-0 text-xs text-ink-muted sm:w-44">{formatIST(e.at)} · {e.actor}</span>
              <span className="text-ink-soft">{e.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
