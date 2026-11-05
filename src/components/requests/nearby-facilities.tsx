import { Badge, CardHeader, EmptyBlock, Panel } from "@/components/ui/primitives";
import type { NearbyFacilitiesResult } from "@/features/institutions/types";

/**
 * Hospitals and blood banks near a request, for the family's tracking page.
 * Verified places come first; everything else is labelled as unverified public
 * information that must be confirmed by phone. Blood stock is never claimed.
 */
export function NearbyFacilities({ result }: { result: NearbyFacilitiesResult }) {
  const where = result.radiusKm ? `within ${result.radiusKm} km` : result.origin === "city" ? "in the same city" : "nearby";
  return (
    <Panel aria-labelledby="nearby-facilities" className="p-6">
      <CardHeader
        id="nearby-facilities"
        title="Nearby blood banks & hospitals"
        note={`${result.facilities.length ? `${result.facilities.length} places ${where}. ` : ""}Call before going: MarutiX can't confirm blood stock.`}
      />
      {result.facilities.length === 0 ? (
        <EmptyBlock className="mt-4">MarutiX hasn&apos;t found hospitals or blood banks near this request yet. The team keeps looking.</EmptyBlock>
      ) : (
        <ol className="mt-4 space-y-3">
          {result.facilities.map((f) => (
            <li key={f.id} className="rounded-md border-2 border-ink bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display text-base font-extrabold tracking-[-0.02em] text-ink">{f.name}</p>
                  <p className="mt-0.5 text-sm text-ink-soft">
                    {f.capabilityLabel}
                    {f.distanceKm !== null && <> · {f.distanceKm} km</>}
                  </p>
                </div>
                <Badge tone={f.verification === "verified" ? "good" : "warn"} dot>
                  {f.verification === "verified" ? "Verified" : "Unverified"}
                </Badge>
              </div>
              {f.address && <p className="mt-2 text-sm text-ink-soft">{f.address}</p>}
              {f.openingHours && <p className="mt-1 text-xs text-ink-muted">Hours (as listed): {f.openingHours}</p>}
              {(f.phones.length > 0 || f.website) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {f.phones.map((p) => (
                    <a key={p.value} href={`tel:${p.value}`} className="inline-flex min-h-11 items-center rounded-md border-2 border-ink bg-paper px-3 text-sm font-bold text-ink shadow-brut-xs brut-press-sm">
                      Call {p.value}
                      {!p.verified && <span className="ml-1 font-normal text-ink-muted">(unverified)</span>}
                    </a>
                  ))}
                  {f.website && (
                    <a href={f.website} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center rounded-md border-2 border-ink bg-surface px-3 text-sm font-bold text-ink underline decoration-2 underline-offset-2">
                      Website
                    </a>
                  )}
                </div>
              )}
              <p className="mt-2 text-xs text-ink-muted">{f.label}</p>
            </li>
          ))}
        </ol>
      )}
      {(result.availabilityNote || result.attribution) && (
        <p className="mt-4 space-x-1 text-xs text-ink-muted">
          {result.availabilityNote && <span>{result.availabilityNote}</span>}
          {result.attribution && <span>{result.attribution}</span>}
        </p>
      )}
    </Panel>
  );
}
