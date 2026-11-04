import type { DiscoveredInstitution } from "@/server/discovery/normalize";

/**
 * A source of nearby institutions. Implementations return only what the
 * source publishes; they never invent contact details. Add a provider (for
 * example an authorised government directory) by implementing this interface.
 */
export interface DiscoveryProvider {
  readonly name: "openstreetmap";
  /** Institutions within `radiusKm` of a point. */
  searchNearby(point: { latitude: number; longitude: number }, radiusKm: number): Promise<DiscoveredInstitution[]>;
  /** An approximate point for an address, or null. */
  geocode(query: { address: string; locality: string; city: string }): Promise<{ latitude: number; longitude: number } | null>;
}
