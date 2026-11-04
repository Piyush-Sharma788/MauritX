import { AlertIcon } from "@/components/ui/icons";

/** Product safety copy from PRD.md §8. Shown prominently wherever help is offered. */
export const SAFETY_COPY =
  "MarutiX helps coordinate contacts. It does not guarantee donor eligibility, blood availability or compatibility. Contact the treating hospital/blood centre immediately; do not delay urgent medical care while using this app.";

export function SafetyNotice({ className = "" }: { className?: string }) {
  return (
    <aside
      aria-label="Medical safety notice"
      className={`flex gap-3.5 rounded-2xl border border-warning-200 bg-warning-50 p-4 text-sm leading-relaxed text-warning-800 sm:p-5 ${className}`}
    >
      <AlertIcon className="mt-0.5 size-5 shrink-0" />
      <p>
        <strong className="font-semibold">Important: </strong>
        {SAFETY_COPY} In a life-threatening emergency, call <a className="font-semibold underline underline-offset-2" href="tel:112">112</a>.
      </p>
    </aside>
  );
}
