import type { ComponentProps, ReactNode } from "react";
import { InfoIcon } from "@/components/ui/icons";

/** Shared field look: 2px ink outline, sharp corners, a hard shadow that grows on focus. */
export const inputClasses =
  "h-12 w-full rounded-md border-2 bg-surface px-3.5 text-[1rem] font-medium text-ink shadow-brut-xs outline-none transition-[box-shadow,background-color] duration-150 placeholder:text-ink-muted/70 focus:bg-signal-50 focus:shadow-brut disabled:opacity-60";

/** Same look for multi-line text. */
export const textareaClasses =
  "w-full rounded-md border-2 border-ink bg-surface px-3.5 py-2.5 text-[0.95rem] font-medium text-ink shadow-brut-xs outline-none transition-[box-shadow,background-color] duration-150 placeholder:text-ink-muted/70 focus:bg-signal-50 focus:shadow-brut disabled:opacity-60";

const borderFor = (error?: string) => (error ? "border-danger-600" : "border-ink");

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
      <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-sm font-bold text-ink">
        {label}
        {optional && <span className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-ink-muted">Optional</span>}
      </label>
      <div className="mt-2">{children}</div>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 flex items-start gap-1.5 text-xs font-bold text-danger-600">
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
      <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-ink" fill="none" stroke="currentColor" strokeWidth={2.5}>
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
            className={`relative flex min-h-12 cursor-pointer flex-col justify-center rounded-md border-2 px-3.5 py-3 transition-[transform,box-shadow,background-color] duration-150 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${
              checked
                ? "-translate-x-0.5 -translate-y-0.5 border-ink bg-brand-500 text-white shadow-brut"
                : `${error ? "border-danger-600" : "border-ink"} bg-surface text-ink shadow-brut-xs hover:bg-signal-50`
            }`}
          >
            <input type="radio" name={name} value={option.value} checked={checked} onChange={() => onChange(option.value)} className="sr-only" />
            <span className="text-[0.95rem] font-bold">{option.label}</span>
            {option.description && <span className={`mt-0.5 text-xs leading-snug ${checked ? "text-white/90" : "text-ink-muted"}`}>{option.description}</span>}
          </label>
        );
      })}
    </div>
  );
}

export function Checkbox({ id, checked, onChange, children, error }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode; error?: string }) {
  return (
    <label htmlFor={id} className={`flex cursor-pointer gap-3 rounded-md border-2 p-4 transition-[background-color,box-shadow] duration-150 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${checked ? "border-ink bg-mint-50 shadow-brut-sm" : error ? "border-danger-600 bg-surface" : "border-ink bg-surface hover:bg-signal-50"}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-ink)] focus-visible:outline-none"
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
      className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-md border-2 border-ink shadow-brut-xs transition-colors disabled:opacity-60 ${checked ? "bg-mint-400" : "bg-paper-deep"}`}
    >
      <span className={`inline-block size-5 rounded-sm border-2 border-ink bg-surface transition-transform duration-150 ${checked ? "translate-x-7" : "translate-x-1"}`} />
    </button>
  );
}
