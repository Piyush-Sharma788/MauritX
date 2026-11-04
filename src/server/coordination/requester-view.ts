import "server-only";
import type { Types } from "mongoose";
import { CAPABILITY_LABELS, INSTITUTION_RESPONSE_LABELS } from "@/features/coordination/schemas";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import type { RequesterCoordinationView } from "@/features/requests/types";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { listEvents } from "@/server/coordination/events";
import { zoneLabel } from "@/server/coordination/zones";
import { DonorProfile } from "@/server/models/donor-profile";
import type { EmergencyRequestDoc } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { InstitutionOutreach } from "@/server/models/institution-outreach";
import { RequestResponse } from "@/server/models/request-response";
import { User } from "@/server/models/user";

/**
 * What the requester (manage link) or family (view link) sees about
 * coordination. Institution names are public; donor identities appear only on
 * the manage link, and contact details never appear here (they are revealed
 * one at a time, logged, through revealDonorContact).
 */
export async function requesterCoordination(request: EmergencyRequestDoc & { _id: Types.ObjectId }, scope: "manage" | "view"): Promise<RequesterCoordinationView> {
  const [outreach, responses, history] = await Promise.all([
    InstitutionOutreach.find({ requestId: request._id, status: { $ne: "excluded" } }).sort({ rank: 1 }).limit(30).lean(),
    RequestResponse.find({ requestId: request._id }).sort({ respondedAt: -1 }).limit(50).lean(),
    listEvents(request._id, { requesterOnly: true, limit: 30 }),
  ]);
  const institutions = await Institution.find({ _id: { $in: outreach.map((o) => o.institutionId) } }, { displayName: 1, capability: 1 }).lean();
  const nameOf = new Map(institutions.map((i) => [i._id.toString(), i]));
  const contacted = (o: (typeof outreach)[number]) => o.deliveries.some((d) => d.status === "sent" || d.status === "queued" || d.status === "sending");

  let donors: RequesterCoordinationView["donors"] = null;
  if (scope === "manage") {
    const interested = responses.filter((r) => r.response !== "unavailable");
    const [users, profiles] = await Promise.all([
      User.find({ _id: { $in: interested.map((r) => r.donorUserId) } }, { displayName: 1 }).lean(),
      DonorProfile.find({ userId: { $in: interested.map((r) => r.donorUserId) } }, { userId: 1, bloodGroup: 1, locality: 1, city: 1 }).lean(),
    ]);
    const user = new Map(users.map((u) => [u._id.toString(), u]));
    const profile = new Map(profiles.map((p) => [p.userId.toString(), p]));
    donors = interested.map((r) => {
      const p = profile.get(r.donorUserId.toString());
      const shared = Boolean(r.contactSharingConsentAt) && r.response === "interested" && r.coordinationStatus !== "not_proceeding";
      return {
        responseId: r._id.toString(),
        firstName: shared ? (user.get(r.donorUserId.toString())?.displayName?.split(" ")[0] ?? "Donor") : "A registered donor",
        bloodGroup: p ? (p.bloodGroup === "unknown" ? "Not sure" : BLOOD_GROUP_LABELS[p.bloodGroup]) : "-",
        area: shared && p ? `${p.locality}, ${p.city}` : "Private",
        response: r.response,
        coordinationStatus: r.coordinationStatus ?? null,
        contactAvailable: shared,
        requesterContactedAt: r.requesterContactedAt?.toISOString() ?? null,
      };
    });
  }

  const zones = getCoordinationConfig().zonesKm;
  const a = request.automation;
  return {
    automation: a && a.status !== "not_started"
      ? { status: a.status, donorPhase: a.donorPhase, currentZone: a.waves.length ? zoneLabel(a.zoneIndex, zones) : null, donorsAlerted: a.waves.reduce((sum, w) => sum + w.queued, 0) }
      : null,
    institutions: outreach.flatMap((o) => {
      const i = nameOf.get(o.institutionId.toString());
      if (!i) return [];
      return [{
        name: i.displayName,
        type: CAPABILITY_LABELS[i.capability ?? "hospital"],
        distanceKm: o.distanceKm ?? null,
        contacted: contacted(o),
        response: o.response?.status ? { status: o.response.status, label: INSTITUTION_RESPONSE_LABELS[o.response.status], at: o.response.at!.toISOString() } : null,
      }];
    }),
    donorCounts: {
      interested: responses.filter((r) => r.response === "interested").length,
      contactsShared: responses.filter((r) => r.response === "interested" && r.contactSharingConsentAt).length,
    },
    donors,
    history,
  };
}
