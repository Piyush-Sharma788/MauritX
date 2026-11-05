"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { OtpInput } from "@/components/auth/otp-input";
import { Button, Spinner } from "@/components/ui/button";
import { Field, TextInput } from "@/components/ui/form";
import { authApi } from "@/features/auth/api-client";

/** Self-service account deletion: explain, confirm with a fresh code sent to the account's number, then delete. */
export function DeleteAccount({ isStaff }: { isStaff: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<"closed" | "explain" | "code" | "done">("closed");
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setError(null);
    const result = await authApi.requestDeletionOtp();
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setSentTo(result.data.maskedPhone);
    setStep("code");
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    const result = await authApi.deleteAccount(code);
    setBusy(false);
    if (!result.ok) {
      setCode("");
      return setError(result.error.message);
    }
    setStep("done");
  }

  return (
    <section aria-labelledby="delete-account" className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-5 shadow-brut sm:p-6">
      <h2 id="delete-account" className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">Delete your account</h2>
      {step === "done" ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-soft">
          <p role="status">Your account has been deleted and you&apos;ve been signed out.</p>
          <Button variant="secondary" onClick={() => router.replace("/")}>Go to the home page</Button>
        </div>
      ) : isStaff ? (
        <p className="mt-2 text-sm text-ink-soft">Admin accounts can&apos;t be deleted here. Ask a super admin to remove your admin access first.</p>
      ) : step === "closed" ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-soft">
          <p>Permanently remove your donor profile and stop all messages from MarutiX.</p>
          <Button variant="danger" onClick={() => setStep("explain")}>Delete account…</Button>
        </div>
      ) : (
        <div className="mt-3 space-y-4 text-sm leading-relaxed text-ink-soft">
          <ul className="list-disc space-y-1 pl-5">
            <li>Your donor profile, name and number are erased. This can&apos;t be undone.</li>
            <li>You stop receiving alerts. Your number stays on our do-not-message list so it isn&apos;t contacted again; message JOIN on WhatsApp if you ever want to come back.</li>
            <li>If you said you could help with an open request, the coordinator is told you&apos;re no longer available, and your contact details are no longer shared.</li>
            <li>We keep records without your personal details: consent history, security logs and any donation a coordinator already confirmed.</li>
          </ul>
          {step === "explain" ? (
            <div className="flex flex-wrap gap-3">
              <Button variant="danger" onClick={() => void sendCode()} disabled={busy}>{busy && <Spinner />} Send me a code to confirm</Button>
              <Button variant="ghost" onClick={() => setStep("closed")} disabled={busy}>Cancel</Button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              <p>Enter the code we sent to {sentTo}.</p>
              <OtpInput length={6} value={code} onChange={setCode} disabled={busy} invalid={Boolean(error)} />
              <Field id="confirm-delete" label="Type DELETE to confirm">
                <TextInput id="confirm-delete" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={busy} />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" variant="danger-solid" disabled={busy || code.length !== 6 || typed !== "DELETE"}>{busy && <Spinner />} Delete my account</Button>
                <Button type="button" variant="ghost" onClick={() => setStep("closed")} disabled={busy}>Cancel</Button>
              </div>
            </form>
          )}
          {error && <p role="alert" className="text-xs font-bold text-danger-600">{error}</p>}
        </div>
      )}
    </section>
  );
}
