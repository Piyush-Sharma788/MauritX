"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { OtpInput } from "@/components/auth/otp-input";
import { Button, Spinner } from "@/components/ui/button";
import { Field, TextInput } from "@/components/ui/form";
import { ShieldIcon } from "@/components/ui/icons";
import { authApi } from "@/features/auth/api-client";

type Setup = { secret: string; qrSvg: string };

/** Staff second factor: first-time authenticator setup (shows recovery codes once), or the per-session check. */
export function MfaFlow({ enrolled }: { enrolled: boolean }) {
  return (
    <section className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut-lg sm:p-8">
      <span className="flex size-12 items-center justify-center rounded-sm border-2 border-ink bg-signal-300 text-ink shadow-brut-xs">
        <ShieldIcon className="size-5" />
      </span>
      <h1 className="mt-5 font-display text-3xl font-extrabold tracking-[-0.045em] text-ink">Two-factor authentication</h1>
      {enrolled ? <Verify /> : <Enroll />}
    </section>
  );
}

function Verify() {
  const router = useRouter();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  async function submit(value?: string) {
    setBusy(true);
    setError(null);
    const result = await authApi.verifyMfa(useRecovery ? { recoveryCode: recovery } : { code: value ?? code });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      setCode("");
      return;
    }
    if (useRecovery) {
      setRemaining(result.data.recoveryCodesRemaining);
      return;
    }
    router.replace("/admin/operations");
  }

  if (remaining !== null) {
    return (
      <div className="mt-4 space-y-4 text-sm text-ink-soft">
        <p>
          Signed in with a recovery code. That code no longer works. {remaining} {remaining === 1 ? "code is" : "codes are"} left.
          {remaining <= 3 && " Ask a super admin to reset your two-factor setup soon so you can create new codes."}
        </p>
        <Button onClick={() => router.replace("/admin/operations")}>Continue</Button>
      </div>
    );
  }

  return (
    <form
      className="mt-4 space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm leading-relaxed text-ink-soft">
        {useRecovery ? "Enter one of the recovery codes you saved when you set up two-factor authentication." : "Enter the 6-digit code from your authenticator app."}
      </p>
      {useRecovery ? (
        <Field id="recovery" label="Recovery code" error={error ?? undefined}>
          <TextInput id="recovery" value={recovery} onChange={(e) => setRecovery(e.target.value)} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX" disabled={busy} />
        </Field>
      ) : (
        <div>
          <OtpInput length={6} value={code} onChange={setCode} onComplete={(v) => void submit(v)} disabled={busy} invalid={Boolean(error)} describedBy={error ? "mfa-error" : undefined} />
          {error && <p id="mfa-error" role="alert" className="mt-2 text-xs font-bold text-danger-600">{error}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || (useRecovery ? recovery.trim().length < 8 : code.length !== 6)}>
          {busy && <Spinner />} Verify
        </Button>
        <button
          type="button"
          className="inline-flex min-h-11 items-center text-sm font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-4 hover:decoration-4"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setError(null);
          }}
        >
          {useRecovery ? "Use authenticator code" : "Use a recovery code"}
        </button>
      </div>
    </form>
  );
}

function Enroll() {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    const result = await authApi.startMfa();
    setBusy(false);
    if (result.ok) setSetup({ secret: result.data.secret, qrSvg: result.data.qrSvg });
    else setError(result.error.message);
  }

  async function confirm(value?: string) {
    setBusy(true);
    setError(null);
    const result = await authApi.confirmMfa(value ?? code);
    setBusy(false);
    if (result.ok) setRecoveryCodes(result.data.recoveryCodes);
    else {
      setError(result.error.message);
      setCode("");
    }
  }

  if (recoveryCodes) {
    return (
      <div className="mt-4 space-y-4 text-sm text-ink-soft">
        <p className="font-bold text-ink">Two-factor authentication is on. Save these recovery codes now.</p>
        <p>Each one signs you in once if you lose your phone. They won&apos;t be shown again.</p>
        <ul className="grid grid-cols-2 gap-2 rounded-md border-2 border-dashed border-ink bg-signal-50 p-4 font-mono text-base font-semibold text-ink" aria-label="Recovery codes">
          {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <label className="flex items-center gap-2 text-ink">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I&apos;ve stored these somewhere safe
        </label>
        <Button disabled={!saved} onClick={() => router.replace("/admin/operations")}>Continue to admin</Button>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-ink-soft">
        <p>Admin accounts need a second step at every sign-in. You&apos;ll need an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password.</p>
        {error && <p role="alert" className="text-xs font-bold text-danger-600">{error}</p>}
        <Button onClick={() => void start()} disabled={busy}>{busy && <Spinner />} Set up authenticator</Button>
      </div>
    );
  }

  return (
    <form
      className="mt-4 space-y-5 text-sm text-ink-soft"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void confirm();
      }}
    >
      <p>Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- server-generated SVG data URL */}
      <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} alt="Authenticator setup QR code" className="mx-auto aspect-square w-full max-w-56 rounded-md border-2 border-ink bg-white p-2 shadow-brut-sm" />
      <details>
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-4">Can&apos;t scan? Enter the key instead</summary>
        <p className="mt-2 break-all rounded-md border-2 border-ink bg-paper-deep px-3 py-2 font-mono font-semibold text-ink">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
      </details>
      <div>
        <OtpInput length={6} value={code} onChange={setCode} onComplete={(v) => void confirm(v)} disabled={busy} invalid={Boolean(error)} describedBy={error ? "mfa-error" : undefined} />
        {error && <p id="mfa-error" role="alert" className="mt-2 text-xs font-bold text-danger-600">{error}</p>}
      </div>
      <Button type="submit" disabled={busy || code.length !== 6}>{busy && <Spinner />} Turn on</Button>
    </form>
  );
}
