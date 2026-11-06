"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import type { ApiResult } from "@/lib/api/browser-client";

/**
 * A button that calls an admin API and refreshes the page. With `confirm`,
 * it asks first: nothing operational happens on a single accidental click.
 */
export function ActionButton({
  label,
  action,
  confirm,
  variant = "secondary",
  className = "h-9 px-3.5 text-sm",
  onDone,
}: {
  label: ReactNode;
  action: () => Promise<ApiResult<unknown>>;
  confirm?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
  className?: string;
  onDone?: (data: unknown) => void;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    setAsking(false);
    if (!result.ok) return setError(result.error.message);
    onDone?.(result.data);
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      {asking ? (
        <span role="alertdialog" aria-label={confirm} className="inline-flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink">
          <span className="font-medium">{confirm}</span>
          <Button variant={variant === "danger" ? "danger-solid" : "primary"} className="h-8 px-3 text-xs" onClick={run} disabled={pending}>
            {pending && <Spinner className="size-3" />}Confirm
          </Button>
          <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setAsking(false)} disabled={pending}>Cancel</Button>
        </span>
      ) : (
        <Button variant={variant} className={className} disabled={pending} onClick={() => (confirm ? setAsking(true) : run())}>
          {pending && <Spinner className="size-3.5" />}
          {label}
        </Button>
      )}
      {error && (
        <span role="alert" className="flex max-w-xs gap-1.5 text-xs text-danger-600">
          <InfoIcon className="mt-px size-3.5 shrink-0" />
          {error}
        </span>
      )}
    </span>
  );
}
