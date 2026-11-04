import "server-only";
import type { CoordinationSummary, MatchingRunView, OutreachView, ResponseView } from "@/features/coordination/types";
import { AppError } from "@/lib/api/errors";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { listEvents } from "@/server/coordination/events";
import { contactAccessCount } from "@/server/coordination/requester";
import { coordinationSummary, listResponses } from "@/server/coordination/responses";
import { interestTarget, zoneLabel } from "@/server/coordination/zones";
import { getLatestRun } from "@/server/matching/service";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { listOutreach } from "@/server/outreach/service";

export interface AutomationView {
  status: string;
  donorPhase: string;
  discoveryStatus: string;
  discoveredAt: string | null;
  startedAt: string | null;
  currentZone: string | null;
  nextWaveAt: string | null;
  targetInterested: number;
  zonesKm: number[];
  waves: { number: number; zone: string; queued: number; suppressed: number; at: string }[];
  geocoded: boolean;
}

export interface RequestCoordination {
  summary: CoordinationSummary;
  latestRun: MatchingRunView | null;
  responses: ResponseView[];
  automation: AutomationView;
  outreach: OutreachView[];
  events: { type: string; summary: string; actor: string; at: string }[];
  contactAccessEvents: number;
}

/** Everything the admin request page shows about matching, alerts, outreach and responses. */
export async function getRequestCoordination(publicRequestId: string): Promise<RequestCoordination> {
  await connectToDatabase();
  const request = await EmergencyRequest.findOne({ publicRequestId }).lean();
  if (!request) throw new AppError(404, "NOT_FOUND", "We couldn't find that request.");
  const config = getCoordinationConfig();
  const [summary, latestRun, responses, outreach, events, contactAccessEvents] = await Promise.all([
    coordinationSummary(request),
    getLatestRun(request._id),
    listResponses(request._id),
    listOutreach(request._id),
    listEvents(request._id, { limit: 60 }),
    contactAccessCount(request._id),
  ]);
  const a = request.automation;
  return {
    summary,
    latestRun,
    responses,
    outreach,
    events,
    contactAccessEvents,
    automation: {
      status: a?.status ?? "not_started",
      donorPhase: a?.donorPhase ?? "pending",
      discoveryStatus: a?.discoveryStatus ?? "pending",
      discoveredAt: a?.discoveredAt?.toISOString() ?? null,
      startedAt: a?.startedAt?.toISOString() ?? null,
      currentZone: a?.waves.length ? zoneLabel(a.zoneIndex, config.zonesKm) : null,
      nextWaveAt: a?.nextWaveAt?.toISOString() ?? null,
      targetInterested: interestTarget(config.targetInterested, request.unitsRequested),
      zonesKm: config.zonesKm,
      waves: (a?.waves ?? []).map((w) => ({ number: w.number, zone: zoneLabel(w.zoneIndex, config.zonesKm), queued: w.queued, suppressed: w.suppressed, at: w.at.toISOString() })),
      geocoded: Boolean(request.geocodedLocation?.coordinates?.length),
    },
  };
}
