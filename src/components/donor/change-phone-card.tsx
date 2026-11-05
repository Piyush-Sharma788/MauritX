"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { OtpInput } from "@/components/auth/otp-input";
import { Button, Spinner } from "@/components/ui/button";
import { CheckIcon, InfoIcon, PhoneIcon } from "@/components/ui/icons";
import { OTP_LENGTH } from "@/features/auth/schemas";
import { donorApi } from "@/features/donors/api-client";
import { formatNationalDigits, INDIA_COUNTRY_CODE, normalizeIndianMobile, toNationalDigits } from "@/lib/validation/phone";

/** Moves the account to a new number after verifying it with a one-time code. */
export function ChangePhoneCard({ maskedPhone }: { maskedPhone: string }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [digits, setDigits] = useState("");
  const [sentTo, setSentTo] = useState<{ phone: string; masked: string; channel: string } | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const phone = normalizeIndianMobile(digits);
    if (!phone) return setError("Enter a valid 10-digit Indian mobile number.");
    setPending(true);
    const result = await donorApi.requestPhoneOtp(phone);
    setPending(false);
    if (!result.ok) return setError(result.error.message);
    setSentTo({ phone, masked: result.data.maskedPhone, channel: result.data.channel });
    setCode("");
  }

  async function verify(value: string) {
    if (!sentTo || pending || value.length !== OTP_LENGTH) return;
    setError(null);
    setPending(true);
    const result = await donorApi.verifyPhone(sentTo.phone, value);
    setPending(false);
    if (!result.ok) {
      setCode("");
      return setError(result.error.message);
    }
    setDone(`Your mobile number is now ${result.data.maskedPhone}.`);
    router.refresh();
  }

  return (
    <section className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-sm border-2 border-ink bg-signal-300 text-ink">
            <PhoneIcon className="size-5" />
          </span>
          <div>
            <h2 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">Mobile number</h2>
            <p className="text-sm text-ink-soft">{maskedPhone}</p>
          </div>
        </div>
        {!open && !done && (
          <Button variant="secondary" className="h-10 px-4 text-sm" onClick={() => setOpen(true)}>
            Change mobile number
          </Button>
        )}
      </div>

      {done && (
        <p role="status" className="mt-4 flex gap-2 rounded-md border-2 border-ink bg-mint-50 px-3.5 py-3 text-sm font-semibold text-ink">
          <CheckIcon className="mt-px size-4 shrink-0" /> {done}
        </p>
      )}

      {open && !done && (
        <div className="mt-5 border-t-2 border-ink pt-5">
          {!sentTo ? (
            <form onSubmit={sendCode} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label htmlFor={`${id}-phone`} className="text-sm font-bold text-ink">New mobile number</label>
                <div className="mt-2 flex h-12 items-center overflow-hidden rounded-md border-2 border-ink bg-surface shadow-brut-xs transition-[box-shadow,background-color] focus-within:bg-signal-50 focus-within:shadow-brut">
                  <span className="flex h-full items-center border-r-2 border-ink bg-signal-300 px-3 font-mono text-sm font-bold text-ink">{INDIA_COUNTRY_CODE}</span>
                  <input
                    id={`${id}-phone`}
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    placeholder="98765 43210"
                    value={formatNationalDigits(digits)}
                    onChange={(e) => setDigits(toNationalDigits(e.target.value).slice(0, 10))}
                    className="h-full min-w-0 flex-1 bg-transparent px-3 text-ink outline-none placeholder:text-ink-muted/60"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
                <Button type="submit" disabled={pending}>{pending && <Spinner />}Send code</Button>
              </div>
            </form>
          ) : (
            <div>
              <p className="text-sm text-ink-soft">
                {sentTo.channel === "whatsapp" ? "Enter the 6-digit code we sent on WhatsApp to " : "Enter the 6-digit development code (printed in the server terminal) for "}
                <strong className="text-ink">{sentTo.masked}</strong>.
              </p>
              <div className="mt-4 max-w-sm">
                <OtpInput length={OTP_LENGTH} value={code} onChange={setCode} onComplete={verify} disabled={pending} invalid={Boolean(error)} />
              </div>
              <div className="mt-4 flex gap-2">
                <Button variant="ghost" className="h-10 px-4 text-sm" onClick={() => { setSentTo(null); setError(null); }} disabled={pending}>Use a different number</Button>
                <Button className="h-10 px-4 text-sm" onClick={() => verify(code)} disabled={pending || code.length !== OTP_LENGTH}>{pending && <Spinner />}Verify</Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 flex gap-2 text-sm font-semibold text-danger-600">
              <InfoIcon className="mt-px size-4 shrink-0" />{error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
