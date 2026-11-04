import "server-only";
import { ALERTABLE_STATUSES } from "@/features/coordination/schemas";
import { OPEN_STATUSES, type RequestStatus } from "@/features/requests/schemas";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { zoneLabel } from "@/server/coordination/zones";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { InstitutionOutreach } from "@/server/models/institution-outreach";
import { MatchingRun } from "@/server/models/matching-run";
import { NotificationEvent } from "@/server/models/notification-event";
import { RequestResponse } from "@/server/models/request-response";
import { expireOverdueRequests } from "@/server/requests/service";

/**
 * The live coordination overview: one row per open request, every figure
 * counted from records. Discovered ≠ contacted ≠ responded; notified ≠
 * interested ≠ donated. Each is its own column.
 */

export interface CoordinationRow {
  publicRequestId: string;
  status: RequestStatus;
  bloodGroup: string;
  component: string;
  unitsRequested: number;
  city: string;
  requiredBy: string;
  automation: string;
  donorPhase: string;
  currentZone: string | null;
  institutionsDiscovered: number;
  institutionsContacted: number;
  institutionsResponded: number;
  institutionsCanAssist: number;
  outreachAwaitingReview: number;
  donorsMatched: number;
  donorsNotified: number;
  donorsInterested: number;
  awaitingCoordination: number;
  donationsConfirmed: number;
  failedMessages: number;
}

export async function getCoordinationOverview(now = new Date()): Promise<{ rows: CoordinationRow[]; totals: Omit<CoordinationRow, "publicRequestId" | "status" | "bloodGroup" | "component" | "unitsRequested" | "city" | "requiredBy" | "automation" | "donorPhase" | "currentZone"> }> {
  await connectToDatabase();
  await expireOverdueRequests(now);
  const zones = getCoordinationConfig().zonesKm;
  const requests = await EmergencyRequest.find({ status: { $in: OPEN_STATUSES } }).sort({ requiredBy: 1 }).limit(100).lean();
  const ids = requests.map((r) => r._id);
  const idStrings = ids.map(String);

  const [outreach, alerts, responses, runs] = await Promise.all([
    InstitutionOutreach.find({ requestId: { $in: ids } }, { requestId: 1, status: 1, deliveries: 1, response: 1 }).lean(),
    NotificationEvent.aggregate<{ _id: { r: string; s: string }; n: number }>([
      { $match: { kind: "emergency_request", requestId: { $in: idStrings } } },
      { $group: { _id: { r: "$requestId", s: "$status" }, n: { $sum: 1 } } },
    ]),
    RequestResponse.find({ requestId: { $in: ids } }, { requestId: 1, response: 1, coordinationStatus: 1 }).lean(),
    MatchingRun.aggregate<{ _id: unknown; candidates: number; contacted: number }>([
      { $match: { requestId: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$requestId", candidates: { $first: { $size: "$candidates" } }, contacted: { $first: { $ifNull: ["$excluded.already_contacted", 0] } } } },
    ]),
  ]);

  const rows: CoordinationRow[] = requests.map((r) => {
    const key = r._id.toString();
    const o = outreach.filter((x) => x.requestId.toString() === key);
    const a = alerts.filter((x) => x._id.r === key);
    const resp = responses.filter((x) => x.requestId.toString() === key);
    const run = runs.find((x) => String(x._id) === key);
    const count = (statuses: string[]) => a.filter((x) => statuses.includes(x._id.s)).reduce((s, x) => s + x.n, 0);
    return {
      publicRequestId: r.publicRequestId,
      status: r.status,
      bloodGroup: r.bloodGroup,
      component: r.component,
      unitsRequested: r.unitsRequested,
      city: r.city,
      requiredBy: r.requiredBy.toISOString(),
      automation: (ALERTABLE_STATUSES as readonly string[]).includes(r.status) ? (r.automation?.status ?? "not_started") : r.status === "verified" ? "waiting_for_activation" : "waiting_for_verification",
      donorPhase: r.automation?.donorPhase ?? "pending",
      currentZone: r.automation?.waves?.length ? zoneLabel(r.automation.zoneIndex, zones) : null,
      institutionsDiscovered: o.length,
      institutionsContacted: o.filter((x) => x.deliveries.some((d) => d.status === "sent")).length,
      institutionsResponded: o.filter((x) => x.response?.status).length,
      institutionsCanAssist: o.filter((x) => x.response?.status === "can_assist").length,
      outreachAwaitingReview: o.filter((x) => x.status === "awaiting_review").length,
      donorsMatched: run ? run.candidates + run.contacted : 0,
      donorsNotified: count(["sent", "delivered", "read"]),
      donorsInterested: resp.filter((x) => x.response === "interested").length,
      awaitingCoordination: resp.filter((x) => x.response === "interested" && x.coordinationStatus === "interested").length,
      donationsConfirmed: resp.filter((x) => x.coordinationStatus === "donation_confirmed").length,
      failedMessages: count(["failed"]) + o.reduce((s, x) => s + x.deliveries.filter((d) => d.status === "failed").length, 0),
    };
  });

  const sum = (k: keyof CoordinationRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  return {
    rows,
    totals: {
      institutionsDiscovered: sum("institutionsDiscovered"),
      institutionsContacted: sum("institutionsContacted"),
      institutionsResponded: sum("institutionsResponded"),
      institutionsCanAssist: sum("institutionsCanAssist"),
      outreachAwaitingReview: sum("outreachAwaitingReview"),
      donorsMatched: sum("donorsMatched"),
      donorsNotified: sum("donorsNotified"),
      donorsInterested: sum("donorsInterested"),
      awaitingCoordination: sum("awaitingCoordination"),
      donationsConfirmed: sum("donationsConfirmed"),
      failedMessages: sum("failedMessages"),
    },
  };
}
