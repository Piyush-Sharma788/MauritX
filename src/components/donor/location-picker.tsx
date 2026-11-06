"use client";

import { useState, type ReactNode } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { CheckIcon, MapPinIcon } from "@/components/ui/icons";
import { coarsenLocation, locationSchema } from "@/features/donors/schemas";

type Location = { latitude: number; longitude: number } | null;

/**
 * Optional location. Explains the purpose before the browser prompt, keeps
 * only coarse precision, and works fine if permission is denied.
 */
export function LocationPicker({
  value,
  onChange,
  description = "Helps us alert you only about requests near you. We save it to about 1 km and never show it to anyone.",
  addedLabel = "Approximate location added (about 1 km)",
  deniedHint = "That's fine: your city and locality are enough.",
  precision = 2,
}: {
  value: Location;
  onChange: (value: Location) => void;
  description?: ReactNode;
  addedLabel?: string;
  deniedHint?: string;
  /** Decimal places kept: 2 is about 1 km, 3 is about 100 m. */
  precision?: 2 | 3;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function locate() {
    setMessage(null);
    if (!("geolocation" in navigator)) {
      setMessage(`Your browser can't share location. ${deniedHint}`);
      return;
    }
    setPending(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setPending(false);
        const parsed = locationSchema.safeParse({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        if (!parsed.success) {
          setMessage(parsed.error.issues[0]?.message ?? "We couldn't use that location.");
          return;
        }
        const factor = 10 ** precision;
        onChange(
          precision === 2
            ? coarsenLocation(parsed.data)
            : { latitude: Math.round(parsed.data.latitude * factor) / factor, longitude: Math.round(parsed.data.longitude * factor) / factor },
        );
      },
      (error) => {
        setPending(false);
        setMessage(
          error.code === error.PERMISSION_DENIED
            ? `Location permission was denied. ${deniedHint}`
            : "We couldn't get your location. You can try again or skip this.",
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  return (
    <div className="rounded-md border border-dashed border-line bg-paper p-4">
      {value ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-bold text-success-600">
            <CheckIcon className="size-4" /> {addedLabel}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" className="h-9 px-3 text-sm" onClick={locate} disabled={pending}>
              Update
            </Button>
            <Button type="button" variant="ghost" className="h-9 px-3 text-sm" onClick={() => onChange(null)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex gap-2.5 text-sm leading-relaxed text-ink-soft">
            <MapPinIcon className="mt-0.5 size-4.5 shrink-0 text-brand-600" />
            {description}
          </p>
          <Button type="button" variant="secondary" className="h-10 shrink-0 px-4 text-sm" onClick={locate} disabled={pending}>
            {pending && <Spinner />}
            Use my location
          </Button>
        </div>
      )}
      {message && <p className="mt-2.5 text-xs text-ink-muted">{message}</p>}
    </div>
  );
}
