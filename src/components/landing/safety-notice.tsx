import { AlertIcon } from "@/components/ui/icons";

/** Product safety copy from PRD.md §8. Shown prominently wherever help is offered. */
export const SAFETY_COPY =
  "MarutiX helps coordinate contacts. It does not guarantee donor eligibility, blood availability or compatibility. Contact the treating hospital/blood centre immediately; do not delay urgent medical care while using this app.";

export function SafetyNotice({ className = "" }: { className?: string }) {
  return (
    <aside
      aria-label="Medical safety notice"
      className={`flex overflow-hidden rounded-md border-2 border-ink bg-signal-50 text-sm leading-relaxed text-ink shadow-brut ${className}`}
    >
      <span aria-hidden="true" className="flex w-11 shrink-0 items-start justify-center border-r-2 border-ink bg-stripes pt-4 sm:w-14">
        <span className="flex size-8 items-center justify-center rounded-sm border-2 border-ink bg-signal-300">
          <AlertIcon className="size-4.5" strokeWidth={2.5} />
        </span>
      </span>
      <p className="min-w-0 p-4 sm:p-5">
        <strong className="font-bold">Important: </strong>
        {SAFETY_COPY} In a life-threatening emergency, call{" "}
        <a className="font-bold underline decoration-2 underline-offset-2" href="tel:112">112</a>.
      </p>
    </aside>
  );
}
