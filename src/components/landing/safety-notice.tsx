import { AlertIcon } from "@/components/ui/icons";

/** Product safety copy from PRD.md §8. Shown prominently wherever help is offered. */
export const SAFETY_COPY =
  "MarutiX helps coordinate contacts. It does not guarantee donor eligibility, blood availability or compatibility. Contact the treating hospital/blood centre immediately; do not delay urgent medical care while using this app.";

export function SafetyNotice({ className = "" }: { className?: string }) {
  return (
    <aside
      aria-label="Medical safety notice"
      className={`flex gap-3 rounded-xl border border-warning-200 bg-warning-50 p-4 text-sm leading-relaxed text-ink sm:p-5 ${className}`}
    >
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-100 text-warning-800">
        <AlertIcon className="size-4.5" />
      </span>
      <p className="min-w-0">
        <strong className="font-semibold">Important: </strong>
        {SAFETY_COPY} In a life-threatening emergency, call{" "}
        <a className="font-semibold text-brand-600 underline underline-offset-2" href="tel:112">112</a>.
      </p>
    </aside>
  );
}
