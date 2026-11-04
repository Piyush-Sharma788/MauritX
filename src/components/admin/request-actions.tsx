"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { adminRequestApi } from "@/features/requests/api-client";
import { STATUS_LABELS, type RequestStatus } from "@/features/requests/schemas";

const VERB: Partial<Record<RequestStatus, string>> = {
  verified: "Mark verified",
  active: "Mark active",
  partially_fulfilled: "Partially fulfilled",
  fulfilled: "Mark fulfilled",
  cancelled: "Cancel request",
};

/** Admin status changes. Every change needs an explicit click and confirmation; nothing is automatic. */
export function RequestStatusActions({ publicRequestId, allowed }: { publicRequestId: string; allowed: RequestStatus[] }) {
  const router = useRouter();
  const [target, setTarget] = useState<RequestStatus | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    if (!target) return;
    setPending(true);
    setError(null);
    const result = await adminRequestApi.setStatus(publicRequestId, target, note.trim() || undefined);
    setPending(false);
    if (!result.ok) return setError(result.error.message);
    setTarget(null);
    setNote("");
    router.refresh();
  }

  if (allowed.length === 0) return <p className="text-sm text-ink-muted">This request is closed. No further status changes are possible.</p>;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {allowed.map((s) => (
          <Button
            key={s}
            variant={s === "cancelled" ? "danger" : s === "verified" ? "primary" : "secondary"}
            className="h-10 px-4 text-sm"
            onClick={() => { setTarget(s); setError(null); }}
            disabled={pending}
          >
            {VERB[s] ?? STATUS_LABELS[s]}
          </Button>
        ))}
      </div>
      {target && (
        <div role="alertdialog" aria-labelledby="admin-confirm" className="mt-4 rounded-2xl border border-line-strong bg-paper-deep/60 p-4">
          <p id="admin-confirm" className="text-sm font-semibold text-ink">Change status to “{STATUS_LABELS[target]}”?</p>
          {target === "verified" && <p className="mt-1 text-xs text-ink-soft">Only verify after confirming the need directly with the hospital or blood bank.</p>}
          <label className="mt-3 block text-xs font-semibold text-ink-soft">
            Internal note (optional, never shown on tracking links)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} className="mt-1 w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-500" placeholder="e.g. Confirmed with blood bank, Dr. on duty" />
          </label>
          <div className="mt-3 flex gap-2">
            <Button variant={target === "cancelled" ? "danger-solid" : "primary"} className="h-10 px-4 text-sm" onClick={apply} disabled={pending}>
              {pending && <Spinner />}Confirm
            </Button>
            <Button variant="ghost" className="h-10 px-4 text-sm" onClick={() => setTarget(null)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 flex gap-2 text-sm text-danger-600"><InfoIcon className="mt-px size-4 shrink-0" />{error}</p>}
    </div>
  );
}

export function RevokeLinkButton({ publicRequestId, linkId }: { publicRequestId: string; linkId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      className="h-8 px-3 text-xs text-danger-600 hover:bg-danger-50"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const result = await adminRequestApi.revokeLink(publicRequestId, linkId);
        setPending(false);
        if (result.ok) router.refresh();
      }}
    >
      {pending && <Spinner className="size-3" />}Turn off
    </Button>
  );
}
