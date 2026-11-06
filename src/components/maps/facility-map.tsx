"use client";

import "leaflet/dist/leaflet.css";
import type { LatLngBounds, Map as LeafletMap } from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";

export type MapFacilityKind = "hospital" | "blood_bank";

export interface MapPoint {
  id: string;
  latitude: number;
  longitude: number;
  name: string;
  kind: MapFacilityKind;
  verified: boolean;
  /** One short line under the name in the popup (capability, distance…). */
  detail?: string | null;
  /** Optional link shown in the popup (an admin page, a tel: link…). */
  href?: string | null;
  hrefLabel?: string | null;
}

export interface MapRing {
  radiusKm: number;
  label: string;
}

interface Props {
  points: MapPoint[];
  /** The search centre. Drawn as an approximate area, never as a precise pin. */
  center?: { latitude: number; longitude: number } | null;
  /** Radius of the search area around `center`. */
  radiusKm?: number | null;
  /** Coverage rings around `center` (e.g. donor alert zones). Donors themselves are never placed on the map. */
  rings?: MapRing[];
  ariaLabel: string;
  className?: string;
}

const RED = "#d92d20";
const SLATE = "#344054";
const DROP = "M15 7.5c2.6 3.1 5.2 6.4 5.2 9.3a5.2 5.2 0 0 1-10.4 0c0-2.9 2.6-6.2 5.2-9.3Z";
const CROSS = "M13.2 9.5h3.6v4.2H21v3.6h-4.2v4.2h-3.6v-4.2H9v-3.6h4.2z";

/** Static marker art (no user data inside). Unverified places get a hollow pin. */
function pinSvg(kind: MapFacilityKind, verified: boolean) {
  const color = kind === "blood_bank" ? RED : SLATE;
  const fill = verified ? color : "#ffffff";
  const glyphFill = verified ? "#ffffff" : color;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37s12-12.4 12-21.6A12 12 0 0 0 3 15.4C3 24.6 15 37 15 37Z" fill="${fill}" stroke="${color}" stroke-width="2"/><path d="${kind === "blood_bank" ? DROP : CROSS}" fill="${glyphFill}"/></svg>`;
}

/** Popup content built with DOM text nodes: facility names come from public sources and are never parsed as HTML. */
function popupFor(p: MapPoint): HTMLElement {
  const root = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = p.name;
  name.style.display = "block";
  root.appendChild(name);
  const meta = document.createElement("span");
  meta.textContent = [p.kind === "blood_bank" ? "Blood bank" : "Hospital", p.verified ? "verified" : "unverified, call to confirm", p.detail].filter(Boolean).join(" · ");
  meta.style.color = "#5f6b7d";
  root.appendChild(meta);
  if (p.href) {
    const link = document.createElement("a");
    link.href = p.href;
    link.textContent = p.hrefLabel ?? "Open";
    link.style.display = "block";
    link.style.marginTop = "6px";
    link.style.fontWeight = "600";
    link.style.color = RED;
    root.appendChild(link);
  }
  return root;
}

/**
 * Interactive map of hospitals and blood banks (Leaflet + OpenStreetMap tiles).
 * The list next to it stays the accessible, complete source; the map is a visual aid.
 */
export function FacilityMap({ points, center = null, radiusKm = null, rings = [], ariaLabel, className = "h-72" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Re-create the map only when the data actually changes, not on every render.
  const key = useMemo(() => JSON.stringify({ points, center, radiusKm, rings }), [points, center, radiusKm, rings]);

  useEffect(() => {
    const { points, center, radiusKm, rings } = JSON.parse(key) as Required<Pick<Props, "points" | "rings">> & Pick<Props, "center" | "radiusKm">;
    let map: LeafletMap | null = null;
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !ref.current) return;
      map = L.map(ref.current, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
        // Tracking pages send no Referer (their URL holds a token); tiles get the site origin only.
        referrerPolicy: "origin",
      }).addTo(map);

      map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');

      // Frame the places themselves (street level); fall back to the search area when there are none.
      let placeBounds: LatLngBounds | null = null;
      let areaBounds: LatLngBounds | null = null;

      if (center) {
        const areaRadiusM = Math.max(radiusKm ?? 1.5, 0.5) * 1000;
        L.circle([center.latitude, center.longitude], {
          radius: areaRadiusM,
          color: RED,
          weight: 1.5,
          dashArray: "5 5",
          fillColor: RED,
          fillOpacity: 0.05,
          interactive: false,
        }).addTo(map);
        // Bounds from geometry, not from the rendered layer: layers only render once the map has a view.
        areaBounds = L.latLng(center.latitude, center.longitude).toBounds(areaRadiusM * 2);
        for (const ring of rings) {
          L.circle([center.latitude, center.longitude], { radius: ring.radiusKm * 1000, color: SLATE, weight: 1, dashArray: "2 6", fill: false })
            .bindTooltip(ring.label, { sticky: true })
            .addTo(map);
        }
        L.circleMarker([center.latitude, center.longitude], { radius: 6, color: "#ffffff", weight: 2, fillColor: RED, fillOpacity: 1 })
          .bindTooltip("Search area (approximate)")
          .addTo(map);
      }

      for (const p of points) {
        const icon = L.divIcon({ className: "", html: pinSvg(p.kind, p.verified), iconSize: [30, 38], iconAnchor: [15, 37], popupAnchor: [0, -32] });
        L.marker([p.latitude, p.longitude], { icon, title: p.name, alt: p.name, keyboard: true, riseOnHover: true })
          .bindPopup(popupFor(p))
          .addTo(map);
        placeBounds = placeBounds ? placeBounds.extend([p.latitude, p.longitude]) : L.latLngBounds([[p.latitude, p.longitude], [p.latitude, p.longitude]]);
      }

      const places = placeBounds as LatLngBounds | null;
      const area = areaBounds as LatLngBounds | null;
      if (places?.isValid()) {
        // Include the centre so the family sees where the search started.
        if (center) places.extend([center.latitude, center.longitude]);
        map.fitBounds(places.pad(0.25), { maxZoom: 15 });
      } else if (area?.isValid()) map.fitBounds(area, { maxZoom: 13 });
      else map.setView([22.6, 79.0], 4); // India
    })().catch(() => setFailed(true));

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [key]);

  return (
    <div className={`relative isolate overflow-hidden rounded-xl border border-line bg-paper-deep ${className}`}>
      <div ref={ref} role="region" aria-label={ariaLabel} className="absolute inset-0" />
      {failed && <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ink-muted">The map couldn&apos;t load. The list below has every place.</p>}
    </div>
  );
}

/** Legend shared by every facility map. */
export function MapLegend({ showArea = false, className = "" }: { showArea?: boolean; className?: string }) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted ${className}`}>
      <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-full bg-brand-500" />Blood bank</li>
      <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-full bg-signal-800" />Hospital</li>
      <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-full border-2 border-signal-800 bg-surface" />Unverified</li>
      {showArea && <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-full border border-dashed border-brand-500 bg-brand-50" />Search area (approximate)</li>}
    </ul>
  );
}
