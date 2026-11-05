import "server-only";
import { randomUUID } from "node:crypto";
import { OPEN_STATUSES } from "@/features/requests/schemas";
import { connectToDatabase } from "@/lib/db/mongoose";
import { encryptPii } from "@/lib/security/crypto";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { InstitutionOutreach } from "@/server/models/institution-outreach";
import { RequestResponse } from "@/server/models/request-response";
import { RequestShareLink } from "@/server/models/request-share-link";
import { recordAudit } from "@/server/services/audit";
import { requestRetentionDays } from "@/lib/privacy/retention-config";

export const REMOVED = "[removed]";
const BATCH = 200;

/**
 * Removes patient and requester details from requests closed more than
 * `days` ago. Kept: blood group, component, units, hospital, city, status
 * history (notes removed) and counters, for reporting. Share links are
 * revoked and institution contact details from responses are erased.
 * Idempotent; processes at most `limit` requests per call.
 */
export async function anonymizeClosedRequests(now = new Date(), days = requestRetentionDays(), limit = BATCH): Promise<number> {
  await connectToDatabase();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const due = await EmergencyRequest.find(
    { status: { $nin: OPEN_STATUSES }, closedAt: { $lte: cutoff }, anonymizedAt: null },
    { _id: 1 },
  )
    .limit(limit)
    .lean();
  if (due.length === 0) return 0;

  let done = 0;
  for (const { _id } of due) {
    const updated = await EmergencyRequest.updateOne(
      { _id, anonymizedAt: null, status: { $nin: OPEN_STATUSES } },
      {
        $set: {
          anonymizedAt: now,
          patientNameEncrypted: encryptPii(REMOVED),
          contactNameEncrypted: encryptPii(REMOVED),
          contactPhoneEncrypted: encryptPii(REMOVED),
          contactPhoneLookup: `anonymized:${_id.toString()}`,
          dedupeKey: `anonymized:${_id.toString()}`,
        },
        $unset: { "history.$[].note": 1, patientAge: 1, requesterPhoneLookup: 1, requesterPhoneEncrypted: 1, hospitalPhone: 1, location: 1, geocodedLocation: 1 },
      },
    );
    if (updated.modifiedCount === 0) continue;
    await RequestResponse.updateMany({ requestId: _id }, { $unset: { "coordinationHistory.$[].note": 1 } });
    await RequestShareLink.updateMany({ requestId: _id, revokedAt: null }, { $set: { revokedAt: now } });
    await InstitutionOutreach.updateMany(
      { requestId: _id },
      { $unset: { "response.contactNameEncrypted": 1, "response.contactPhoneEncrypted": 1, "response.note": 1, responseTokenHash: 1 } },
    );
    done += 1;
  }
  if (done > 0) await recordAudit({ action: "retention.requests_anonymized", outcome: "success", requestId: randomUUID(), resourceType: "emergency_request", resourceId: `count:${done}` });
  return done;
}
