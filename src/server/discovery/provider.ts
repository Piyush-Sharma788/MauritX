import type { DiscoveredInstitution } from "@/server/discovery/normalize";

/**
 * A source of nearby institutions. Implementations return only what the
 * source publishes; they never invent contact details. Add a provider (for
 * example an authorised government directory) by implementing this interface.
 */
export interface DiscoveryProvider {
  readonly name: string;
  /** Institutions within `radiusKm` of a point. */
  searchNearby(point: { latitude: number; longitude: number }, radiusKm: number): Promise<DiscoveredInstitution[]>;
  /**
   * Optional: the same search, saying whether the source's own result cap was
   * hit. Refresh only marks records stale after a complete result.
   */
  searchNearbyDetailed?(point: { latitude: number; longitude: number }, radiusKm: number): Promise<{ items: DiscoveredInstitution[]; truncated: boolean }>;
  /** An approximate point for an address, or null. */
  geocode(query: { address: string; locality: string; city: string }): Promise<{ latitude: number; longitude: number } | null>;
}

/** The source asked us to slow down (HTTP 429) or is overloaded (502/503/504): back off, don't retry at once. */
export class ProviderThrottledError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null = null) {
    super(`Source throttled or overloaded (HTTP ${status})`);
    this.name = "ProviderThrottledError";
  }
}
