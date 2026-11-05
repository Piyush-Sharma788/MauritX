"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ActionButton } from "@/components/admin/action-button";
import { Button, Spinner } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { inputClasses } from "@/components/ui/form";
import { coordinationApi } from "@/features/coordination/api-client";
import { CHANNEL_STATUSES, CHANNEL_TYPES, INSTITUTION_RESPONSE_LABELS, INSTITUTION_RESPONSES, type ChannelStatus, type ChannelType, type InstitutionResponse, type OutreachStatus, type ReviewStatus } from "@/features/coordination/schemas";

/** Admin controls for Phase 6 coordination. Each takes IDs only and calls the admin API. */

export function AutomationControls({ publicRequestId, status, alertable }: { publicRequestId: string; status: string; alertable: boolean }) {
  const run = (action: Parameters<typeof coordinationApi.automation>[1]) => () => coordinationApi.automation(publicRequestId, action);
  return (
    <div className="flex flex-wrap gap-2">
      {status === "not_started" && alertable && <ActionButton label="Start automation" variant="primary" confirm="Start discovery, outreach and donor waves now?" action={run("start")} />}
      {status === "running" && <ActionButton label="Pause" confirm="Pause automatic donor waves and outreach?" action={run("pause")} />}
      {status === "paused" && alertable && <ActionButton label="Resume" variant="primary" confirm="Resume automatic coordination?" action={run("resume")} />}
      {status === "running" && alertable && <ActionButton label="Send next wave now" confirm="Alert the next donors now instead of waiting?" action={run("run_wave_now")} />}
      {alertable && status !== "cancelled" && <ActionButton label="Search institutions again" action={run("rediscover")} />}
      {(status === "running" || status === "paused") && <ActionButton label="Cancel automation" variant="danger" confirm="Stop all automatic outreach and waves for this request, and withdraw queued alerts?" action={run("cancel")} />}
    </div>
  );
}

export function OutreachActions({ publicRequestId, outreachId, status, alertable }: { publicRequestId: string; outreachId: string; status: OutreachStatus; alertable: boolean }) {
  const [recording, setRecording] = useState(false);
  const [response, setResponse] = useState<InstitutionResponse>("can_assist");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function record() {
    setPending(true);
    setError(null);
    const result = await coordinationApi.outreach(publicRequestId, outreachId, { action: "record_response", response });
    setPending(false);
    if (!result.ok) return setError(result.error.message);
    setRecording(false);
    router.refresh();
  }
  const sendable = ["awaiting_review", "no_contact", "channel_unavailable"].includes(status);
  return (
    <div className="flex flex-wrap items-start gap-2">
      {alertable && sendable && <ActionButton label="Send now" className="h-8 px-3 text-xs" action={() => coordinationApi.outreach(publicRequestId, outreachId, { action: "send" })} />}
      {alertable && status === "failed" && <ActionButton label="Retry" className="h-8 px-3 text-xs" confirm="Send this outreach again?" action={() => coordinationApi.outreach(publicRequestId, outreachId, { action: "retry" })} />}
      {status !== "cancelled" && status !== "excluded" && <ActionButton label="Cancel" variant="ghost" className="h-8 px-3 text-xs" action={() => coordinationApi.outreach(publicRequestId, outreachId, { action: "cancel" })} />}
      {recording ? (
        <span className="inline-flex flex-wrap items-center gap-2 rounded-md border-2 border-ink bg-paper px-2 py-1.5">
          <select aria-label="Response" value={response} onChange={(e) => setResponse(e.target.value as InstitutionResponse)} className="h-8 rounded-md border-2 border-ink bg-surface px-2 text-xs">
            {INSTITUTION_RESPONSES.map((r) => <option key={r} value={r}>{INSTITUTION_RESPONSE_LABELS[r]}</option>)}
          </select>
          <Button className="h-8 px-3 text-xs" onClick={record} disabled={pending}>{pending && <Spinner className="size-3" />}Save</Button>
          <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setRecording(false)}>Cancel</Button>
        </span>
      ) : (
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setRecording(true)}>Record a phone answer</Button>
      )}
      {error && <span role="alert" className="text-xs text-danger-600">{error}</span>}
    </div>
  );
}

export function ReviewButtons({ institutionId, status }: { institutionId: string; status: ReviewStatus }) {
  return (
    <div className="flex flex-wrap gap-2">
      {status !== "approved" && (
        <ActionButton label="Approve for outreach" variant="primary" confirm="Relevant institution, and its contacts are official?" action={() => coordinationApi.reviewInstitution(institutionId, "approved")} />
      )}
      {status !== "excluded" && (
        <ActionButton label="Exclude" variant="danger" confirm="Never contact this institution?" action={() => coordinationApi.reviewInstitution(institutionId, "excluded")} />
      )}
    </div>
  );
}

const input = `${inputClasses} h-9 border-line-strong text-sm`;

/** Add a contact, or correct one (value and status). */
export function ChannelEditor({ institutionId, channel }: { institutionId: string; channel?: { id: string; type: ChannelType; value: string; status: ChannelStatus } }) {
  const router = useRouter();
  const [open, setOpen] = useState(!channel);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const body = { type: String(d.get("type")) as ChannelType, value: String(d.get("value") ?? "").trim(), status: String(d.get("status")) as ChannelStatus };
    setPending(true);
    setError(null);
    const result = channel ? await coordinationApi.updateChannel(institutionId, channel.id, body) : await coordinationApi.addChannel(institutionId, body);
    setPending(false);
    if (!result.ok) {
      const fields = result.error.details?.fields as Record<string, string> | undefined;
      return setError(fields ? Object.values(fields)[0] : result.error.message);
    }
    if (channel) setOpen(false);
    else form.reset();
    router.refresh();
  }
  if (!open) return <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setOpen(true)}>Correct</Button>;
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <select name="type" defaultValue={channel?.type ?? "email"} aria-label="Type" className={`${input} w-28`}>
        {CHANNEL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input name="value" required defaultValue={channel?.value ?? ""} aria-label="Value" placeholder="bloodbank@hospital.in" className={`${input} min-w-48 flex-1`} />
      <select name="status" defaultValue={channel?.status ?? "verified"} aria-label="Status" className={`${input} w-32`}>
        {CHANNEL_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
      </select>
      <Button type="submit" className="h-9 px-3 text-xs" disabled={pending}>{pending && <Spinner className="size-3" />}{channel ? "Save" : "Add contact"}</Button>
      {channel && <Button variant="ghost" className="h-9 px-2 text-xs" onClick={() => setOpen(false)}>Cancel</Button>}
      {error && <span role="alert" className="flex w-full gap-1 text-xs text-danger-600"><InfoIcon className="size-3.5" />{error}</span>}
    </form>
  );
}

export function ChannelStatusButton({ institutionId, channelId, to, label }: { institutionId: string; channelId: string; to: ChannelStatus; label: string }) {
  return <ActionButton label={label} variant={to === "invalid" ? "ghost" : "secondary"} className="h-8 px-3 text-xs" action={() => coordinationApi.setChannelStatus(institutionId, channelId, to)} />;
}

export function RetryJobButton({ jobId }: { jobId: string }) {
  return <ActionButton label="Retry" confirm="Run this job again?" className="h-8 px-3 text-xs" action={() => coordinationApi.retryJob(jobId)} />;
}
