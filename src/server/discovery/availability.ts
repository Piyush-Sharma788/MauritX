import "server-only";
import { getDiscoveryConfig } from "@/lib/discovery/config";

/**
 * Live blood stock availability, by institution. LIMITATION: India's
 * e-RaktKosh (NBTC/NHM) publishes stock on its portal but offers no public
 * API, and MarutiX does not scrape it. So today every lookup answers
 * "unknown"; MarutiX only shows what an institution itself reported on
 * WhatsApp (availability_reports), labelled as self-reported.
 *
 * To add a real source (an authorised API or data-sharing agreement),
 * implement `BloodAvailabilitySource` and select it with
 * BLOOD_AVAILABILITY_PROVIDER. It must return what the source states, with
 * its own timestamp, and never infer stock.
 */

export type AvailabilityStatus = "available" | "not_available" | "unknown";

export interface AvailabilityQuery {
  institutionId: string;
  externalRefs: string[];
  bloodGroup?: string;
  component?: string;
}

export interface AvailabilityAnswer {
  status: AvailabilityStatus;
  source: string;
  /** When the source last updated this figure; null when unknown. */
  asOf: string | null;
  units: number | null;
  note: string;
}

export interface BloodAvailabilitySource {
  readonly name: string;
  lookup(query: AvailabilityQuery): Promise<AvailabilityAnswer>;
}

export const NO_PUBLIC_SOURCE_NOTE = "Live blood stock isn't available to MarutiX: e-RaktKosh has no public API. Call the blood bank to confirm stock.";

/** The default: no authorised live source exists, so availability is unknown. */
export class NoAvailabilitySource implements BloodAvailabilitySource {
  readonly name = "none";
  async lookup(): Promise<AvailabilityAnswer> {
    return { status: "unknown", source: "none", asOf: null, units: null, note: NO_PUBLIC_SOURCE_NOTE };
  }
}

let override: BloodAvailabilitySource | undefined;

export function setAvailabilitySourceForTests(source: BloodAvailabilitySource | undefined) {
  override = source;
}

export function activeAvailabilitySource(): BloodAvailabilitySource {
  if (override) return override;
  switch (getDiscoveryConfig().availabilityProvider) {
    case "none":
    default:
      return new NoAvailabilitySource();
  }
}
