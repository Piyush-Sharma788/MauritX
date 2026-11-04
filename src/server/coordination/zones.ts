/**
 * Zone-wise donor waves, as pure functions. Zones are operational distance
 * bands (default 0–5, 5–10, 10–25, 25–50 km), not medical rules. Waves start
 * with the closest zone; a zone is finished before the next is opened, and a
 * newly eligible donor in an earlier zone is never skipped. Donors in the same
 * city without a shared location form a final stage after the last zone.
 */

export interface ZoneCandidate {
  donorUserId: string;
  rank: number;
  distanceKm: number | null;
}

/** Index of the zone a distance falls in; `zones.length` is the "same city, no location" stage; -1 is beyond the last zone. */
export function zoneIndexFor(distanceKm: number | null, zonesKm: number[]): number {
  if (distanceKm === null) return zonesKm.length;
  const i = zonesKm.findIndex((outer) => distanceKm <= outer);
  return i === -1 ? -1 : i;
}

export interface WavePlan {
  zoneIndex: number;
  selected: ZoneCandidate[];
  exhausted: boolean;
  /** Candidates left in the current or earlier zones after this wave. */
  remainingInZone: number;
}

export function planWave(candidates: ZoneCandidate[], zonesKm: number[], currentZone: number, waveSize: number): WavePlan {
  const byRank = [...candidates].sort((a, b) => a.rank - b.rank);
  for (let zone = Math.max(0, currentZone); zone <= zonesKm.length; zone++) {
    const eligible = byRank.filter((c) => {
      const z = zoneIndexFor(c.distanceKm, zonesKm);
      return z !== -1 && z <= zone;
    });
    if (eligible.length) {
      const selected = eligible.slice(0, waveSize);
      return { zoneIndex: zone, selected, exhausted: false, remainingInZone: eligible.length - selected.length };
    }
  }
  return { zoneIndex: zonesKm.length, selected: [], exhausted: true, remainingInZone: 0 };
}

/** How many interested donors end the expansion: configured, or twice the units needed. */
export function interestTarget(configured: number, unitsRequested: number): number {
  return configured > 0 ? configured : Math.max(2, unitsRequested * 2);
}

export const zoneLabel = (zoneIndex: number, zonesKm: number[]) =>
  zoneIndex >= zonesKm.length ? "same city (no location shared)" : `${zoneIndex === 0 ? 0 : zonesKm[zoneIndex - 1]}–${zonesKm[zoneIndex]} km`;
