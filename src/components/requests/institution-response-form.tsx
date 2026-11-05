"use client";

import { useState, type FormEvent } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { CheckIcon, InfoIcon } from "@/components/ui/icons";
import { inputClasses, textareaClasses } from "@/components/ui/form";
import { INSTITUTION_RESPONSE_LABELS, INSTITUTION_RESPONSES, type InstitutionResponse } from "@/features/coordination/schemas";
import { apiRequest } from "@/lib/api/browser-client";

const CHOICES: Record<InstitutionResponse, string> = {
  can_assist: "We may be able to assist",
  cannot_assist: "We can't assist",
  need_info: "We need more information",
};

export function InstitutionResponseForm({ token, current, emailOptOutAvailable }: { token: string; current: { status: InstitutionResponse; at: string } | null; emailOptOutAvailable: boolean }) {
  const [choice, setChoice] = useState<InstitutionResponse | null>(current?.status ?? null);
  const [pending, setPending] = useState<"save" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<InstitutionResponse | null>(current?.status ?? null);
  const [stopped, setStopped] = useState(false);
  const headers = { "X-Outreach-Token": token };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!choice) return setError("Choose an answer.");
    const data = new FormData(e.currentTarget);
    const text = (k: string) => String(data.get(k) ?? "").trim() || undefined;
    setPending("save");
    setError(null);
    const result = await apiRequest<{ response: InstitutionResponse }>("POST", "/api/v1/outreach/respond", { body: { response: choice, contactName: text("contactName"), contactPhone: text("contactPhone"), note: text("note") }, headers });
    setPending(null);
    if (!result.ok) {
      const fields = result.error.details?.fields as Record<string, string> | undefined;
      return setError(fields ? Object.values(fields)[0] : result.error.message);
    }
    setSaved(choice);
  }

  async function stopEmails() {
    setPending("stop");
    const result = await apiRequest<{ unsubscribed: number }>("POST", "/api/v1/outreach/unsubscribe", { headers });
    setPending(null);
    if (result.ok) setStopped(true);
    else setError(result.error.message);
  }

  return (
    <section className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-5 shadow-brut sm:p-6">
      <h2 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">Can your institution assist?</h2>
      {saved && (
        <p role="status" className="mt-3 flex gap-2 rounded-md border-2 border-ink bg-mint-50 px-3 py-2 text-sm font-semibold text-ink">
          <CheckIcon className="mt-0.5 size-4 shrink-0" />Recorded: {INSTITUTION_RESPONSE_LABELS[saved]}. You can change it below.
        </p>
      )}
      <form onSubmit={submit} className="mt-4 space-y-4">
        <fieldset className="grid gap-2 sm:grid-cols-3">
          <legend className="sr-only">Answer</legend>
          {INSTITUTION_RESPONSES.map((r) => (
            <label key={r} className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-md border-2 border-ink px-3 py-3 text-sm font-bold transition-[transform,box-shadow,background-color] duration-150 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${choice === r ? "-translate-x-0.5 -translate-y-0.5 bg-ink text-white shadow-[4px_4px_0_0_var(--color-brand-500)]" : "bg-surface text-ink shadow-brut-xs hover:bg-signal-50"}`}>
              <input type="radio" name="response" value={r} checked={choice === r} onChange={() => setChoice(r)} className="sr-only" />
              {CHOICES[r]}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-bold text-ink">Contact person (optional)<input name="contactName" maxLength={60} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`} /></label>
          <label className="text-xs font-bold text-ink">Blood bank phone (optional)<input name="contactPhone" inputMode="tel" maxLength={24} className={`${inputClasses} mt-1 h-11 border-line-strong text-sm`} /></label>
        </div>
        <label className="block text-xs font-bold text-ink">Note (optional)<textarea name="note" maxLength={500} rows={3} className={`${textareaClasses} mt-1 text-sm`} placeholder="e.g. Please ask the family to call the blood bank counter" /></label>
        <p className="text-xs text-ink-muted">If you give a phone number, the family may be told to call it. Please use an institutional number, not a personal one.</p>
        <Button type="submit" disabled={pending !== null}>{pending === "save" && <Spinner />}Send answer</Button>
      </form>
      {error && <p role="alert" className="mt-3 flex gap-2 text-sm font-semibold text-danger-600"><InfoIcon className="mt-px size-4 shrink-0" />{error}</p>}
      {emailOptOutAvailable && (
        <div className="mt-6 border-t-2 border-ink pt-4 text-xs text-ink-muted">
          {stopped ? "MarutiX won't email this address again." : (
            <button type="button" onClick={stopEmails} disabled={pending !== null} className="font-semibold text-ink-soft underline hover:text-ink">Stop MarutiX emails to this address</button>
          )}
        </div>
      )}
    </section>
  );
}
