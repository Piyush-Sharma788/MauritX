"use client";

import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";

interface OtpInputProps {
  length: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * Segmented one-time-code input. Supports typing, paste, SMS/WhatsApp
 * autofill (`autocomplete="one-time-code"`), backspace and arrow keys.
 */
export function OtpInput({ length, value, onChange, onComplete, disabled, invalid, describedBy }: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  const focusAt = (index: number) => refs.current[Math.max(0, Math.min(length - 1, index))]?.focus();

  const commit = (next: string) => {
    const clean = next.replace(/\D/g, "").slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
    return clean;
  };

  const fillFrom = (index: number, incoming: string) => {
    const chars = incoming.replace(/\D/g, "");
    if (!chars) return;
    // A full-length value (autofill or paste) replaces everything.
    const next = chars.length >= length ? chars : (value.slice(0, index) + chars + value.slice(index + chars.length)).slice(0, length);
    const committed = commit(next);
    focusAt(Math.min(committed.length, length - 1));
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (digits[index]) {
        commit(value.slice(0, index) + value.slice(index + 1));
      } else if (index > 0) {
        commit(value.slice(0, index - 1) + value.slice(index));
        focusAt(index - 1);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      focusAt(index + 1);
    }
  };

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    fillFrom(index, event.clipboardData.getData("text"));
  };

  return (
    <div role="group" aria-label={`${length}-digit verification code`} aria-describedby={describedBy} className={`flex justify-between gap-2 sm:gap-3 ${invalid ? "animate-shake" : ""}`}>
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${index + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          autoFocus={index === 0}
          disabled={disabled}
          value={digit}
          // Digits always fill sequentially (see fillFrom), so any box can take focus.
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            // Typing into a filled box yields two characters; keep only the new one.
            const raw = e.target.value;
            const incoming = digit && raw.length === 2 ? (raw.startsWith(digit) ? raw.slice(1) : raw.slice(0, 1)) : raw;
            fillFrom(index, incoming);
          }}
          onKeyDown={(e) => onKeyDown(index, e)}
          onPaste={(e) => onPaste(index, e)}
          className={`aspect-[5/6] w-full min-w-0 max-w-14 rounded-2xl border bg-surface text-center font-display text-2xl font-semibold text-ink caret-brand-500 shadow-soft transition outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100 disabled:opacity-60 sm:text-[1.7rem] ${
            invalid ? "border-danger-600 ring-4 ring-danger-50" : digit ? "border-ink/25" : "border-line-strong"
          }`}
        />
      ))}
    </div>
  );
}
