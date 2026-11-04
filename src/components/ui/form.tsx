import type { ComponentProps, ReactNode } from "react";
import { InfoIcon } from "@/components/ui/icons";

export const inputClasses =
  "h-12 w-full rounded-xl border bg-surface px-3.5 text-[1rem] text-ink shadow-soft outline-none transition placeholder:text-ink-muted/60 focus:border-brand-500 focus:ring-4 focus:ring-brand-100 disabled:opacity-60";

const borderFor = (error?: string) => (error ? "border-danger-600" : "border-line-strong");

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
      <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-sm font-semibold text-ink">
        {label}
        {optional && <span className="text-xs font-normal text-ink-muted">Optional</span>}
      </label>
      <div className="mt-2">{children}</div>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-danger-600">
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
            className={`relative flex cursor-pointer flex-col justify-center rounded-xl border px-3.5 py-3 transition has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-100 ${
              checked ? "border-brand-500 bg-brand-50 text-brand-700 shadow-soft" : `${error ? "border-danger-600" : "border-line-strong"} bg-surface text-ink hover:border-ink/30`
            }`}
          >
            <input type="radio" name={name} value={option.value} checked={checked} onChange={() => onChange(option.value)} className="sr-only" />
            <span className="text-[0.95rem] font-semibold">{option.label}</span>
            {option.description && <span className={`mt-0.5 text-xs leading-snug ${checked ? "text-brand-700/80" : "text-ink-muted"}`}>{option.description}</span>}
          </label>
        );
      })}
    </div>
  );
}

export function Checkbox({ id, checked, onChange, children, error }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode; error?: string }) {
  return (
    <label htmlFor={id} className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${checked ? "border-brand-500 bg-brand-50/60" : error ? "border-danger-600" : "border-line-strong bg-surface"}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-brand-500)]"
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
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${checked ? "bg-success-600" : "bg-line-strong"}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}
