"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { OtpInput } from "@/components/auth/otp-input";
import { Button, Spinner } from "@/components/ui/button";
import { AlertIcon, ArrowLeftIcon, ChatIcon, CheckIcon, InfoIcon } from "@/components/ui/icons";
import { authApi } from "@/features/auth/api-client";
import { OTP_LENGTH, type SendOtpResponse } from "@/features/auth/schemas";
import {
  formatNationalDigits,
  INDIA_COUNTRY_CODE,
  isValidIndianMobile,
  normalizeIndianMobile,
  toNationalDigits,
} from "@/lib/validation/phone";

type Step =
  | { name: "phone" }
  | { name: "otp"; phoneE164: string; delivery: SendOtpResponse }
  | { name: "success" };

type Pending = "send" | "verify" | "resend" | null;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

const formatSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function PhoneLoginFlow() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: "phone" });
  const [digits, setDigits] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const ids = { phone: useId(), phoneHint: useId(), status: useId() };

  const now = useNow(step.name === "otp");
  const msUntil = (iso: string) => Math.max(0, new Date(iso).getTime() - now);
  // Round the resend wait up (never enable early) and the expiry down (never overstate validity).
  const resendIn = step.name === "otp" ? Math.ceil(msUntil(step.delivery.resendAvailableAt) / 1000) : 0;
  const expiresIn = step.name === "otp" ? Math.floor(msUntil(step.delivery.expiresAt) / 1000) : 0;

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    setNotice(null);
    const phoneE164 = normalizeIndianMobile(digits);
    if (!phoneE164) {
      setError(digits ? "Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9." : "Enter your mobile number.");
      phoneInputRef.current?.focus();
      return;
    }
    setPending("send");
    const result = await authApi.sendOtp(phoneE164);
    setPending(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCode("");
    setStep({ name: "otp", phoneE164, delivery: result.data });
  }

  async function resendCode() {
    if (step.name !== "otp" || resendIn > 0) return;
    setError(null);
    setNotice(null);
    setPending("resend");
    const result = await authApi.sendOtp(step.phoneE164);
    setPending(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCode("");
    setStep({ ...step, delivery: result.data });
    setNotice(result.data.channel === "whatsapp" ? "A new code is on its way to WhatsApp." : "A new development code was generated.");
  }

  async function verifyCode(value: string) {
    if (step.name !== "otp" || pending) return;
    setError(null);
    setNotice(null);
    if (value.length !== OTP_LENGTH) {
      setError("Enter all 6 digits of the code.");
      return;
    }
    setPending("verify");
    const result = await authApi.verifyOtp(step.phoneE164, value);
    if (!result.ok) {
      setPending(null);
      const remaining = result.error.details?.attemptsRemaining;
      setError(
        typeof remaining === "number"
          ? `${result.error.message} ${remaining} ${remaining === 1 ? "attempt" : "attempts"} left.`
          : result.error.message,
      );
      setCode("");
      setShakeKey((k) => k + 1);
      return;
    }
    setStep({ name: "success" });
    router.replace(result.data.redirectTo);
    router.refresh();
  }

  function changeNumber() {
    setStep({ name: "phone" });
    setCode("");
    setError(null);
    setNotice(null);
    requestAnimationFrame(() => phoneInputRef.current?.focus());
  }

  const heading = step.name === "otp" ? "Enter your code" : "Sign in to MarutiX";

  return (
    <div className="w-full">
      <div aria-live="polite" id={ids.status} className="sr-only">
        {pending === "send" || pending === "resend" ? "Sending code" : pending === "verify" ? "Verifying code" : ""}
      </div>

      {step.name === "success" ? (
        <div className="flex flex-col items-center py-10 text-center" role="status">
          <span className="flex size-16 items-center justify-center rounded-full bg-success-50 text-success-600">
            <CheckIcon className="size-8" />
          </span>
          <h1 className="mt-5 font-display text-2xl font-bold tracking-tight text-ink">You&apos;re verified</h1>
          <p className="mt-2 flex items-center gap-2 text-ink-soft">
            <Spinner /> Taking you to your dashboard…
          </p>
        </div>
      ) : (
        <>
          {step.name === "otp" && (
            <button
              type="button"
              onClick={changeNumber}
              className="-ml-2 mb-4 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-ink-soft hover:bg-ink/5 hover:text-ink"
            >
              <ArrowLeftIcon className="size-4" /> Change number
            </button>
          )}

          <h1 className="font-display text-[1.9rem] font-bold leading-tight tracking-[-0.035em] text-ink">{heading}</h1>

          {step.name === "phone" ? (
            <p className="mt-2 leading-relaxed text-ink-soft">
              Use the number you registered with on WhatsApp. We&apos;ll send you a one-time code; no password needed.
            </p>
          ) : (
            <p className="mt-2 leading-relaxed text-ink-soft">
              {step.delivery.channel === "whatsapp" ? "We sent a 6-digit code on WhatsApp to " : "A 6-digit code was generated for "}
              <span className="whitespace-nowrap font-semibold text-ink">{step.delivery.maskedPhone}</span>.
            </p>
          )}

          {step.name === "otp" && step.delivery.channel === "development" && (
            <div className="mt-5 flex gap-3 rounded-2xl border border-warning-200 bg-warning-50 p-4 text-sm leading-relaxed text-warning-800" role="note">
              <AlertIcon className="mt-0.5 size-5 shrink-0" />
              <p>
                <strong className="font-semibold">Development mode.</strong> This code was <strong>not</strong> sent via
                WhatsApp. WhatsApp credentials aren&apos;t configured, so the code is printed in the server terminal.
              </p>
            </div>
          )}

          {step.name === "phone" ? (
            <form onSubmit={sendCode} noValidate className="mt-7">
              <label htmlFor={ids.phone} className="text-sm font-semibold text-ink">
                Mobile number
              </label>
              <div
                className={`mt-2 flex h-14 items-center overflow-hidden rounded-2xl border bg-surface shadow-soft transition focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-100 ${
                  error ? "border-danger-600" : "border-line-strong"
                }`}
              >
                <span className="flex h-full items-center gap-2 border-r border-line bg-paper-deep/70 px-4 text-[1.05rem] font-semibold text-ink" aria-hidden="true">
                  <span className="text-lg leading-none">🇮🇳</span>
                  {INDIA_COUNTRY_CODE}
                </span>
                <input
                  ref={phoneInputRef}
                  id={ids.phone}
                  name="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  autoFocus
                  placeholder="98765 43210"
                  aria-describedby={ids.phoneHint}
                  aria-invalid={Boolean(error) || undefined}
                  value={formatNationalDigits(digits)}
                  onChange={(e) => {
                    setDigits(toNationalDigits(e.target.value).slice(0, 10));
                    setError(null);
                  }}
                  disabled={pending === "send"}
                  className="h-full min-w-0 flex-1 bg-transparent px-4 text-[1.15rem] font-medium tracking-wide text-ink outline-none placeholder:text-ink-muted/60"
                />
                {isValidIndianMobile(digits) && (
                  <CheckIcon className="mr-4 size-5 shrink-0 text-success-600" aria-hidden="true" />
                )}
              </div>
              <p id={ids.phoneHint} className="mt-2 text-xs text-ink-muted">
                Indian mobile numbers only (+91). Your number is encrypted and never shown publicly.
              </p>

              <FormError message={error} />

              <Button type="submit" size="lg" className="mt-6 w-full" disabled={pending === "send"}>
                {pending === "send" ? (
                  <>
                    <Spinner /> Sending code…
                  </>
                ) : (
                  <>
                    <ChatIcon className="size-5" /> Send code on WhatsApp
                  </>
                )}
              </Button>

              <p className="mt-5 text-center text-xs leading-relaxed text-ink-muted">
                By continuing, you agree to receive a one-time code on WhatsApp and to our{" "}
                <Link href="/privacy" className="font-medium text-ink-soft underline underline-offset-2 hover:text-brand-600">
                  privacy notice
                </Link>
                .
              </p>
            </form>
          ) : (
            <form
              className="mt-7"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void verifyCode(code);
              }}
            >
              <OtpInput
                key={shakeKey}
                length={step.delivery.codeLength}
                value={code}
                onChange={(v) => {
                  setCode(v);
                  if (error) setError(null);
                }}
                onComplete={(v) => void verifyCode(v)}
                disabled={pending === "verify"}
                invalid={Boolean(error) && shakeKey > 0}
                describedBy={ids.status}
              />

              <p className={`mt-3 text-xs ${expiresIn === 0 ? "font-medium text-danger-600" : "text-ink-muted"}`}>
                {expiresIn > 0 ? `Code expires in ${formatSeconds(expiresIn)}` : "This code has expired. Request a new one below."}
              </p>

              <FormError message={error} />
              {notice && !error && (
                <p role="status" className="mt-4 flex items-center gap-2 text-sm font-medium text-success-600">
                  <CheckIcon className="size-4" /> {notice}
                </p>
              )}

              <Button type="submit" size="lg" className="mt-6 w-full" disabled={pending === "verify" || code.length !== OTP_LENGTH}>
                {pending === "verify" ? (
                  <>
                    <Spinner /> Verifying…
                  </>
                ) : (
                  "Verify & continue"
                )}
              </Button>

              <div className="mt-5 flex items-center justify-center gap-1.5 text-sm text-ink-soft">
                <span>Didn&apos;t get it?</span>
                {resendIn > 0 ? (
                  <span className="font-medium tabular-nums text-ink-muted" aria-live="off">
                    Resend in {formatSeconds(resendIn)}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={resendCode}
                    disabled={pending === "resend"}
                    className="inline-flex items-center gap-1.5 rounded-md font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-60"
                  >
                    {pending === "resend" && <Spinner className="size-3.5" />}
                    Resend code
                  </button>
                )}
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-4 flex gap-2 rounded-xl bg-danger-50 px-3.5 py-3 text-sm leading-snug text-danger-600">
      <InfoIcon className="mt-px size-4 shrink-0" />
      {message}
    </p>
  );
}
