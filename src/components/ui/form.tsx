import type { ComponentProps, ReactNode } from "react";
import { InfoIcon } from "@/components/ui/icons";

/** Shared field look: white, hairline border, a soft red focus ring. */
const fieldBase =
  "w-full rounded-lg border bg-surface text-ink shadow-brut-xs outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-muted/80 focus:border-brand-400 focus:shadow-[0_0_0_4px_rgb(217_45_32/0.12)] disabled:cursor-not-allowed disabled:bg-paper disabled:opacity-70";

export const inputClasses = `h-12 px-3.5 text-[1rem] ${fieldBase}`;

/** Same look for multi-line text. */
export const textareaClasses = `border-line-strong px-3.5 py-2.5 text-[0.95rem] ${fieldBase}`;

const borderFor = (error?: string) => (error ? "border-brand-400" : "border-line-strong");

export function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-sm font-medium text-ink">
        {label}
        {optional && <span className="text-xs font-normal text-ink-muted">Optional</span>}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-brand-600">
          <InfoIcon className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({ error, className = "", id, ...props }: ComponentProps<"input"> & { error?: string; id: string }) {
  return (
    <input
      id={id}
      aria-invalid={Boolean(error) || undefined}
      aria-describedby={error ? `${id}-error` : `${id}-hint`}
      className={`${inputClasses} ${borderFor(error)} ${className}`}
      {...props}
    />
  );
}

export function SelectInput({ error, className = "", id, children, ...props }: ComponentProps<"select"> & { error?: string; id: string }) {
  return (
    <div className="relative">
      <select
        id={id}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        className={`${inputClasses} ${borderFor(error)} appearance-none pr-10 ${className}`}
        {...props}
      >
        {children}
      </select>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** Large tappable radio options, laid out as cards. */
export function RadioCards<T extends string>({
  name,
  value,
  onChange,
  options,
  error,
  columns = 2,
}: {
  name: string;
  value: T | null;
  onChange: (value: T) => void;
  options: { value: T; label: string; description?: string }[];
  error?: string;
  columns?: 2 | 3 | 5;
}) {
  const cols = { 2: "grid-cols-1 sm:grid-cols-2", 3: "grid-cols-3", 5: "grid-cols-3 sm:grid-cols-5" }[columns];
  return (
    <div role="radiogroup" aria-invalid={Boolean(error) || undefined} className={`grid gap-2.5 ${cols}`}>
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            className={`relative flex min-h-12 cursor-pointer flex-col justify-center rounded-lg border px-3.5 py-3 transition-[border-color,box-shadow,background-color] duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500 ${
              checked
                ? "border-brand-500 bg-brand-50 text-ink shadow-[0_0_0_1px_var(--color-brand-500)]"
                : `${error ? "border-brand-400" : "border-line-strong"} bg-surface text-ink shadow-brut-xs hover:border-ink-muted/50 hover:bg-signal-50`
            }`}
          >
            <input type="radio" name={name} value={option.value} checked={checked} onChange={() => onChange(option.value)} className="sr-only" />
            <span className={`flex items-center justify-between gap-2 text-[0.95rem] font-medium ${checked ? "text-brand-700" : ""}`}>
              {option.label}
              <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-brand-500 bg-brand-500" : "border-line-strong bg-surface"}`}>
                {checked && <span className="size-1.5 rounded-full bg-white" />}
              </span>
            </span>
            {option.description && <span className="mt-0.5 text-xs leading-snug text-ink-muted">{option.description}</span>}
          </label>
        );
      })}
    </div>
  );
}

export function Checkbox({ id, checked, onChange, children, error }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode; error?: string }) {
  return (
    <label htmlFor={id} className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition-[background-color,border-color] duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500 ${checked ? "border-mint-300 bg-mint-50" : error ? "border-brand-400 bg-surface" : "border-line-strong bg-surface hover:bg-signal-50"}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-brand-500)] focus-visible:outline-none"
      />
      <span className="text-sm leading-relaxed text-ink-soft">{children}</span>
    </label>
  );
}

/** Accessible on/off switch. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-60 ${checked ? "border-success-600 bg-success-600" : "border-line-strong bg-signal-300"}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow-brut-sm transition-transform duration-200 ease-out ${checked ? "translate-x-6" : "translate-x-0.5"}`} />
    </button>
  );
}
