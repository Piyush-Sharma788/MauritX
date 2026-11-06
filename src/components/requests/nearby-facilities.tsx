import { Droplet, ExternalLink, Hospital, MapPinned, Phone } from "lucide-react";
import { FacilityMap, MapLegend, type MapPoint } from "@/components/maps/facility-map";
import { Badge, CardHeader, EmptyBlock, Panel } from "@/components/ui/primitives";
import type { NearbyFacilitiesResult } from "@/features/institutions/types";

/**
 * Hospitals and blood banks near a request, for the family's tracking page.
 * Verified places come first; everything else is labelled as unverified public
 * information that must be confirmed by phone. Blood stock is never claimed.
 */
/** Map pins for the facilities that have a known position. */
export function facilityPoints(result: NearbyFacilitiesResult): MapPoint[] {
  return result.facilities
    .filter((f) => f.location)
    .map((f) => ({
      id: f.id,
      latitude: f.location!.latitude,
      longitude: f.location!.longitude,
      name: f.name,
      kind: f.type,
      verified: f.verification === "verified",
      detail: [f.capabilityLabel, f.distanceKm !== null ? `${f.distanceKm} km` : null].filter(Boolean).join(" · "),
      href: f.phones[0] ? `tel:${f.phones[0].value}` : null,
      hrefLabel: f.phones[0] ? `Call ${f.phones[0].value}` : null,
    }));
}

export function NearbyFacilities({ result }: { result: NearbyFacilitiesResult }) {
  const where = result.radiusKm ? `within ${result.radiusKm} km` : result.origin === "city" ? "in the same city" : "nearby";
  const points = facilityPoints(result);
  const showMap = points.length > 0;

  return (
    <Panel aria-labelledby="nearby-facilities" className="p-5 sm:p-6">
      <CardHeader
        id="nearby-facilities"
        title={
          <span className="inline-flex items-center gap-2">
            <MapPinned aria-hidden="true" className="size-4.5 text-brand-600" />
            Nearby blood banks & hospitals
          </span>
        }
        note={`${result.facilities.length ? `${result.facilities.length} places ${where}. ` : ""}Call before going: MarutiX can't confirm blood stock.`}
      />
      {showMap && (
        <div className="mt-4">
          <FacilityMap points={points} center={result.center ?? null} radiusKm={result.radiusKm} ariaLabel="Map of nearby blood banks and hospitals" className="h-64 sm:h-80" />
          <MapLegend showArea={Boolean(result.center)} className="mt-2.5" />
        </div>
      )}
      {result.facilities.length === 0 ? (
        <EmptyBlock className="mt-4">MarutiX hasn&apos;t found hospitals or blood banks near this request yet. The team keeps looking.</EmptyBlock>
      ) : (
        <ol className="mt-4 grid gap-3 lg:grid-cols-2">
          {result.facilities.map((f) => {
            const bank = f.type === "blood_bank";
            const Icon = bank ? Droplet : Hospital;
            return (
              <li key={f.id} className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
                <div className="flex items-start gap-3">
                  <span aria-hidden="true" className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${bank ? "bg-brand-50 text-brand-600" : "bg-signal-100 text-signal-800"}`}>
                    <Icon className="size-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="font-display text-[0.95rem] font-semibold leading-snug tracking-[-0.01em] text-ink">{f.name}</p>
                      <Badge tone={f.verification === "verified" ? "good" : "warn"} dot>
                        {f.verification === "verified" ? "Verified" : "Unverified"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-ink-soft">
                      {f.capabilityLabel}
                      {f.distanceKm !== null && <> · <span className="tabular-nums">{f.distanceKm} km</span></>}
                    </p>
                  </div>
                </div>
                {f.address && <p className="mt-3 text-sm text-ink-soft">{f.address}</p>}
                {f.openingHours && <p className="mt-1 text-xs text-ink-muted">Hours (as listed): {f.openingHours}</p>}
                {(f.phones.length > 0 || f.website) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {f.phones.map((p) => (
                      <a key={p.value} href={`tel:${p.value}`} className="brut-press-sm inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-signal-50">
                        <Phone aria-hidden="true" className="size-4 text-brand-600" />
                        Call {p.value}
                        {!p.verified && <span className="font-normal text-ink-muted">(unverified)</span>}
                      </a>
                    ))}
                    {f.website && (
                      <a href={f.website} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink">
                        Website <ExternalLink aria-hidden="true" className="size-3.5" />
                      </a>
                    )}
                  </div>
                )}
                <p className="mt-auto pt-3 text-xs text-ink-muted">{f.label}</p>
              </li>
            );
          })}
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
