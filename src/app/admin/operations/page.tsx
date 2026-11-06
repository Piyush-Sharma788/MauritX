import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import Link from "next/link";

import { Suspense } from "react";
import { BotSwitches, RetryMessageButton } from "@/components/admin/admin-actions";
import { RetryJobButton } from "@/components/admin/coordination-actions";
import { CircleCheck, Clock, Siren, UserRoundCheck } from "lucide-react";
import { Card, EmptyState, PageHeader, Pill, Stat } from "@/components/admin/kit";
import { StatTile } from "@/components/ui/primitives";
import { formatIST } from "@/components/requests/status";
import { Spinner } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireAdminPage } from "@/lib/auth/require-admin";
import { getOperationsOverview, listConversations, listFailedMessages } from "@/server/admin/operations";
import { jobStats, listDeadJobs } from "@/server/jobs/queue";
import { listRecentErrors } from "@/server/monitoring/report";

export const metadata: Metadata = { title: "Operations · Admin", robots: { index: false } };

export default function OperationsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <PageHeader eyebrow="Control centre" title="Operations" />
      <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-ink-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading</span></div>}>
        <OperationsContent />
      </Suspense>
    </div>
  );
}

const STATE_LABEL = { connected: "Connected", connecting: "Connecting", qr_required: "Waiting for QR scan", disconnected: "Disconnected", auth_failed: "Session rejected" } as const;
const FLOW_LABEL: Record<string, string> = {
  donor_onboarding: "Donor registration",
  donor_update: "Donor update",
  emergency_request: "Blood request",
  request_cancel: "Cancellation",
  donor_response: "Alert reply",
};

async function OperationsContent() {
  const user = await requireAdminPage("operations.read");
  const canSettings = can(user.role, "operations.settings");
  const canRetryJobs = can(user.role, "jobs.retry");
  const canReadErrors = can(user.role, "errors.read");

  const [o, failed, { conversations }, jobs, dead] = await Promise.all([
    getOperationsOverview(),
    listFailedMessages(15),
    listConversations(new Types.ObjectId(user.id), randomUUID(), undefined, 15),
    jobStats(),
    listDeadJobs(10),
  ]);
  const errors = canReadErrors ? await listRecentErrors(10) : [];
  const wa = o.whatsapp;
  const waTone = wa.workerOnline && wa.state === "connected" ? "good" : wa.state === "qr_required" ? "warn" : "bad";

  return (
    <div className="mt-8 space-y-6">
      <section aria-labelledby="overview-title">
        <h2 id="overview-title" className="sr-only">Emergency overview</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Active requests" value={o.coordination.activeRequests} hint="Finding donors now" tone={o.coordination.activeRequests ? "bad" : "neutral"} icon={<Siren className="size-4" />} />
          <StatTile label="Pending verification" value={o.coordination.pendingVerification} hint="Waiting on the team" tone={o.coordination.pendingVerification ? "warn" : "neutral"} icon={<Clock className="size-4" />} />
          <StatTile label="Donors interested" value={o.coordination.interested7Days} hint="Last 7 days" tone="info" icon={<UserRoundCheck className="size-4" />} />
          <StatTile label="Requests fulfilled" value={o.coordination.fulfilled7Days} hint="Last 7 days" tone="good" icon={<CircleCheck className="size-4" />} />
        </div>
      </section>
      <Card title="Emergency coordination" id="coord" note="Interest is not a donation. Donations count only when a coordinator confirms them. Alert figures cover the last 7 days.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Pending verification" value={o.coordination.pendingVerification} tone={o.coordination.pendingVerification ? "warn" : "neutral"} />
          <Stat label="Verified, not active" value={o.coordination.verifiedRequests} />
          <Stat label="Active" value={o.coordination.activeRequests} />
          <Stat label="Alerts attempted" value={o.coordination.alertsAttempted7Days} />
          <Stat label="Alerts delivered" value={o.coordination.alertsDelivered7Days} hint="acknowledged by WhatsApp" />
          <Stat label="Donors interested" value={o.coordination.interested7Days} />
          <Stat label="Unavailable replies" value={o.coordination.unavailable7Days} />
          <Stat label="Donations confirmed" value={o.coordination.donationsConfirmed7Days} tone="good" />
          <Stat label="Requests fulfilled" value={o.coordination.fulfilled7Days} tone="good" />
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <Card
          title="WhatsApp connection"
          id="wa"
          note="Pilot via whatsapp-web.js. Delivery is never guaranteed; only acknowledged deliveries are counted."
          actions={<Link href="/admin/whatsapp" className="inline-flex min-h-10 items-center rounded-md border border-line bg-surface px-3 text-sm font-bold text-ink shadow-brut-xs transition-colors hover:bg-signal-100">QR, reconnect & logout →</Link>}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={waTone}>{wa.workerOnline ? STATE_LABEL[wa.state] : "Worker offline"}</Pill>
            {wa.account && <span className="text-sm text-ink-soft">{wa.account.maskedNumber}{wa.account.pushName ? ` · ${wa.account.pushName}` : ""}</span>}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-ink-muted">Last connected</dt><dd className="font-bold text-ink">{wa.lastReadyAt ? formatIST(wa.lastReadyAt) : "Never"}</dd></div>
            <div><dt className="text-xs text-ink-muted">Last disconnect</dt><dd className="font-bold text-ink">{wa.lastDisconnectedAt ? `${formatIST(wa.lastDisconnectedAt)}${wa.lastDisconnectReason ? ` (${wa.lastDisconnectReason})` : ""}` : "None"}</dd></div>
          </dl>
          {wa.lastError && <p className="mt-3 rounded-md bg-danger-50 px-3 py-2 text-xs text-danger-600">{wa.lastError}</p>}
        </Card>

        <Card title="Bot controls" id="controls" note="STOP is always honoured, even with the bot switched off. Changes are audit-logged.">
          {canSettings ? (
            <BotSwitches botEnabled={o.settings.botEnabled} alertsPaused={o.settings.alertsPaused} />
          ) : (
            <p className="text-sm text-ink-soft">
              Bot {o.settings.botEnabled ? "on" : "off"} · alerts {o.settings.alertsPaused ? "paused" : "running"}. Only a super admin can change these.
            </p>
          )}
          <p className="mt-4 text-xs text-ink-muted">
            AI understanding: {o.ai.provider === "none" ? "off (commands and keywords only)" : `${o.ai.provider} · ${o.ai.model}`}. AI only proposes; the bot validates and acts.
          </p>
        </Card>
      </div>

      <Card title="Bot activity" id="bot" note="Counted from stored records. Inbound counts start from when this version was deployed.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="Active conversations" value={o.bot.activeConversations} />
          <Stat label="Messages today" value={o.bot.inboundToday} />
          <Stat label="Messages, 7 days" value={o.bot.inbound7Days} />
          <Stat label="Dropped (bot off)" value={o.bot.droppedWhileDisabled7Days} hint="7 days" tone={o.bot.droppedWhileDisabled7Days ? "warn" : "neutral"} />
          <Stat label="Bot errors" value={o.bot.botErrors7Days} hint="7 days" tone={o.bot.botErrors7Days ? "bad" : "neutral"} />
          <Stat label="AI calls" value={o.bot.aiCalls7Days} hint="7 days" />
          <Stat label="AI errors" value={o.bot.aiErrors7Days} hint="7 days" tone={o.bot.aiErrors7Days ? "bad" : "neutral"} />
          <Stat label="AI output rejected" value={o.bot.aiRejected7Days} hint="7 days" tone={o.bot.aiRejected7Days ? "warn" : "neutral"} />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Notification queue" id="queue">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Queued" value={o.queue.queued} />
            <Stat label="Sending" value={o.queue.sending} />
            <Stat label="Failed, 24 h" value={o.queue.failed24h} tone={o.queue.failed24h ? "bad" : "neutral"} />
            <Stat label="Suppressed, 24 h" value={o.queue.suppressed24h} hint="consent / limits" />
          </div>
        </Card>
        <Card title="Institutions" id="inst" actions={<Link href="/admin/institutions" className="inline-flex min-h-10 items-center rounded-md border border-line bg-surface px-3 text-sm font-bold text-ink shadow-brut-xs transition-colors hover:bg-signal-100">Manage →</Link>}>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Verified" value={o.institutions.verified} tone="good" />
            <Stat label="Awaiting verification" value={o.institutions.pending} tone={o.institutions.pending ? "warn" : "neutral"} />
          </div>
        </Card>
      </div>

      <Card title="Background jobs" id="jobs" note="Discovery, outreach email and donor waves run in the jobs worker (npm run jobs:worker). Jobs that keep failing stop here for review.">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Queued" value={jobs.queued} />
          <Stat label="Running" value={jobs.running} />
          <Stat label="Dead (needs review)" value={jobs.dead} tone={jobs.dead ? "bad" : "neutral"} />
        </div>
        {dead.length > 0 && (
          <ul className="mt-4 divide-y divide-line text-sm">
            {dead.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span><span className="font-bold text-ink">{j.type.replace(/_/g, " ")}</span><span className="block text-xs text-ink-muted">{j.attempts} attempts{j.finishedAt ? ` · ${formatIST(j.finishedAt)}` : ""} · {j.lastError ?? "no error recorded"}</span></span>
                {canRetryJobs && <RetryJobButton jobId={j.id} />}
              </li>
            ))}
          </ul>
        )}
        {jobs.queued > 0 && jobs.running === 0 && <p className="mt-3 text-xs text-warning-800">Jobs are waiting. If this persists, check that the jobs worker is running.</p>}
      </Card>

      {canReadErrors && (
        <Card title="Server errors" id="errors" note="Unexpected errors from the API, pages, workers, WhatsApp and jobs, grouped by kind. Messages are redacted: no numbers, codes or tokens. Kept 90 days after last seen.">
          {errors.length === 0 ? (
            <EmptyState>No unexpected errors recorded.</EmptyState>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {errors.map((e) => (
                <li key={e.fingerprint} className="py-2.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Pill tone="bad">{e.source.replace(/_/g, " ")}</Pill>
                    <span className="font-bold text-ink">{e.event}</span>
                    <span className="text-xs text-ink-muted">{e.count}× · last {formatIST(e.lastSeenAt)}</span>
                  </span>
                  <span className="mt-0.5 block break-words text-xs text-ink-muted">{e.errorName}{e.message ? `: ${e.message}` : ""}{e.where ? ` · ${e.where}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}


      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Failed messages" id="failed" note="Only emergency alerts that certainly weren't delivered can be retried, and only while the request is active.">
          {failed.length === 0 ? (
            <EmptyState>No failed messages.</EmptyState>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {failed.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <span>
                    <span className="font-bold text-ink">{m.kind.replace(/_/g, " ")}</span>
                    <span className="block text-xs text-ink-muted">
                      {m.recipient} · {m.failureCode ?? "unknown"} · {m.attempts} attempt{m.attempts === 1 ? "" : "s"}{m.failedAt ? ` · ${formatIST(m.failedAt)}` : ""}{m.requestPublicId ? ` · ${m.requestPublicId}` : ""}
                    </span>
                  </span>
                  {m.retryable && <RetryMessageButton messageId={m.id} />}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Conversations" id="convos" note="Flow and step only. Message text is never stored. Viewing this list is audit-logged.">
          {conversations.length === 0 ? (
            <EmptyState>No conversations yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {conversations.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span>
                    <span className="font-bold text-ink">{FLOW_LABEL[c.flow] ?? c.flow}</span>
                    <span className="block text-xs text-ink-muted">{c.maskedPhone} · step “{c.state.replace(/_/g, " ")}” · {formatIST(c.updatedAt)}</span>
                  </span>
                  <Pill tone={c.status === "active" ? "brand" : c.status === "completed" ? "good" : "neutral"}>{c.status}</Pill>
                </li>
              ))}
            </ul>
          )}
          {can(user.role, "audit.read") && <p className="mt-3 text-xs"><Link href="/admin/audit" className="font-bold text-brand-700 underline underline-offset-4 hover:text-brand-600">Audit history →</Link></p>}
        </Card>
      </div>
    </div>
  );
}
