import "server-only";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { ALERTABLE_STATUSES, INSTITUTION_RESPONSE_LABELS, type InstitutionResponse } from "@/features/coordination/schemas";
import type { OutreachView } from "@/features/coordination/types";
import { OPEN_STATUSES } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import { getCoordinationConfig } from "@/lib/coordination/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { getEmailConfig } from "@/lib/email/config";
import { getEnv } from "@/lib/env";
import { decryptPii, encryptPii, generateTrackingToken, hashTrackingToken } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { recordEvent } from "@/server/coordination/events";
import { enqueueJob } from "@/server/jobs/queue";
import { enqueueMessage, queueCoordinatorAlert } from "@/server/messaging/queue";
import { EmergencyRequest, type EmergencyRequestDoc } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";
import { InstitutionOutreach, type InstitutionOutreachDoc } from "@/server/models/institution-outreach";
import { EmailSendError, getEmailProvider } from "@/server/outreach/email";
import { planOutreach } from "@/server/outreach/plan";
import { outreachEmail, outreachWhatsApp, type OutreachSummary } from "@/server/outreach/templates";
import { recordAudit } from "@/server/services/audit";

/**
 * Institutional outreach: contacting the institutions found for a request,
 * tracking every delivery, and recording what they answer. A sent message is
 * never treated as an answer, and an answer is never treated as stock.
 */

type OutreachRecord = InstitutionOutreachDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type RequestRecord = EmergencyRequestDoc & { _id: Types.ObjectId };
const DAY_MS = 24 * 60 * 60 * 1000;
const isAlertable = (s: string) => (ALERTABLE_STATUSES as readonly string[]).includes(s);

export const respondUrl = (token: string) => new URL(`/respond/${token}`, getEnv().APP_BASE_URL).toString();

function emailConfigured(): boolean {
  try {
    return getEmailProvider() !== null;
  } catch {
    return false;
  }
}

function summaryFor(request: RequestRecord, url: string): OutreachSummary {
  const config = getCoordinationConfig();
  return {
    publicRequestId: request.publicRequestId,
    bloodGroup: request.bloodGroup,
    component: request.component,
    unitsRequested: request.unitsRequested,
    hospitalName: request.hospitalName,
    locality: request.locality,
    city: request.city,
    requiredBy: request.requiredBy,
    priority: request.priority,
    verified: Boolean(request.verifiedAt),
    respondUrl: url,
    coordinatorPhone: config.coordinatorPhone,
    coordinatorEmail: config.coordinatorEmail,
  };
}

/** Sends (queues) outreach for every outreach record of a request that isn't contacted yet. */
export async function runOutreach(requestObjectId: string, now = new Date()): Promise<{ queued: number; skipped: number }> {
  await connectToDatabase();
  const request = (await EmergencyRequest.findById(requestObjectId).lean()) as RequestRecord | null;
  if (!request || !isAlertable(request.status) || request.expiresAt <= now) return { queued: 0, skipped: 0 };
  if (request.automation?.status === "paused" || request.automation?.status === "cancelled") return { queued: 0, skipped: 0 };

  const config = getCoordinationConfig();
  const canEmail = emailConfigured();
  const records = (await InstitutionOutreach.find({ requestId: request._id, status: { $in: ["no_contact", "awaiting_review", "channel_unavailable", "queued"] } }).sort({ rank: 1 }).lean()) as OutreachRecord[];
  let queued = 0;
  let skipped = 0;

  for (const record of records) {
    if (record.deliveries.length) continue; // Already contacted for this request.
    const institution = await Institution.findById(record.institutionId).lean();
    if (!institution) continue;
    const contacts = await InstitutionContact.find({ institutionId: institution._id, status: "verified" }).lean();
    const plan = planOutreach({
      verificationStatus: institution.verificationStatus,
      reviewStatus: institution.review?.status ?? "approved",
      // An unverified contact its source no longer publishes (stale) is not used automatically.
      channels: (institution.contactChannels ?? []).map((c) => ({ id: c._id.toString(), type: c.type, value: c.value, status: c.status === "unverified" && c.staleSince ? ("invalid" as const) : c.status })),
      verifiedWhatsAppContacts: contacts.length,
      emailConfigured: canEmail,
      includeUnreviewed: config.outreachIncludeUnreviewed,
    });
    if (plan.status !== "queued") {
      await InstitutionOutreach.updateOne({ _id: record._id, "deliveries.0": { $exists: false } }, { $set: { status: plan.status } });
      skipped += 1;
      continue;
    }

    // Don't flood one institution across many requests.
    const recent = await InstitutionOutreach.countDocuments({ institutionId: institution._id, "deliveries.queuedAt": { $gte: new Date(now.getTime() - DAY_MS) } });
    if (recent >= config.outreachMaxPerInstitutionPerDay) {
      skipped += 1;
      continue;
    }

    const token = generateTrackingToken();
    const url = respondUrl(token);
    const summary = summaryFor(request, url);
    const deliveries: Record<string, unknown>[] = [];
    const email = outreachEmail(summary, institution.displayName);
    for (const target of plan.emails) {
      deliveries.push({ _id: new Types.ObjectId(), channel: "email", target: target.value, contactChannelId: new Types.ObjectId(target.id), status: "queued", queuedAt: now, subject: email.subject, bodyEncrypted: encryptPii(email.text) });
    }
    if (plan.whatsapp) {
      for (const contact of contacts) {
        const result = await queueCoordinatorAlert({
          requestId: request._id.toString(),
          phoneE164: decryptPii(contact.phoneEncrypted),
          body: outreachWhatsApp(summary),
          idempotencyKey: `outreach:${record._id.toString()}:${contact._id.toString()}`,
        });
        deliveries.push({ _id: new Types.ObjectId(), channel: "whatsapp", target: maskPhone(decryptPii(contact.phoneEncrypted)), notificationEventId: result.messageId ? new Types.ObjectId(result.messageId) : undefined, status: result.outcome === "suppressed" ? "suppressed" : "queued", queuedAt: now, failureCode: result.outcome === "suppressed" ? result.reason : undefined });
      }
    }
    // Only one runner wins: the update requires the record to still have no deliveries.
    const claimed = await InstitutionOutreach.updateOne(
      { _id: record._id, "deliveries.0": { $exists: false } },
      { $set: { status: "queued", deliveries, responseTokenHash: hashTrackingToken(token), responseTokenExpiresAt: new Date(request.expiresAt.getTime() + DAY_MS) } },
    );
    if (claimed.modifiedCount !== 1) continue;
    for (const d of deliveries) {
      if (d.channel === "email") await enqueueJob("send_outreach_email", `outreach_email:${record._id.toString()}:${String(d._id)}`, { requestId: request._id.toString(), outreachId: record._id.toString(), deliveryId: String(d._id) }, { runAt: now });
    }
    await syncOutreachStatus(record._id);
    queued += 1;
  }

  if (queued) {
    await recordEvent(request._id, "outreach_sent", `Contacted ${queued} hospital${queued === 1 ? "" : "s"} or blood bank${queued === 1 ? "" : "s"} about this request.`, { visibleToRequester: true, at: now });
    await recordAudit({ action: "outreach.queued", outcome: "success", requestId: randomUUID(), resourceType: "emergency_request", resourceId: `${request.publicRequestId}:${queued}` });
  }
  return { queued, skipped };
}

/** Outreach status from its deliveries. WhatsApp deliveries follow their outbox message. */
export async function syncOutreachStatus(outreachId: Types.ObjectId) {
  const record = (await InstitutionOutreach.findById(outreachId).lean()) as OutreachRecord | null;
  if (!record || !record.deliveries.length || record.status === "cancelled") return;
  const states = record.deliveries.map((d) => d.status);
  const sent = states.filter((s) => s === "sent").length;
  const pending = states.some((s) => s === "queued" || s === "sending");
  const status = pending ? (sent ? "partially_sent" : "queued") : sent === states.length ? "sent" : sent ? "partially_sent" : "failed";
  await InstitutionOutreach.updateOne({ _id: record._id }, { $set: { status } });
}

const EMAIL_HOURLY_DEFER_MS = 10 * 60_000;

export type EmailJobOutcome = { kind: "done" } | { kind: "retry"; error: Error } | { kind: "defer"; until: Date };

/** Sends one queued outreach email. Idempotent: a delivery left "sending" by a crash is failed, never re-sent. */
export async function sendOutreachEmail(outreachId: string, deliveryId: string, attempt: { number: number; max: number }, now = new Date()): Promise<EmailJobOutcome> {
  await connectToDatabase();
  const record = (await InstitutionOutreach.findById(outreachId).lean()) as OutreachRecord | null;
  const delivery = record?.deliveries.find((d) => d._id.toString() === deliveryId);
  if (!record || !delivery) return { kind: "done" };
  const setDelivery = (fields: Record<string, unknown>, unset: Record<string, 1> = {}) =>
    InstitutionOutreach.updateOne(
      { _id: record._id, "deliveries._id": delivery._id },
      { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`deliveries.$.${k}`, v])), ...(Object.keys(unset).length ? { $unset: Object.fromEntries(Object.keys(unset).map((k) => [`deliveries.$.${k}`, 1])) } : {}) },
    );
  const finish = async (status: "sent" | "failed" | "suppressed", fields: Record<string, unknown>) => {
    await setDelivery({ status, ...fields }, { bodyEncrypted: 1 });
    await syncOutreachStatus(record._id);
    await recordAudit({ action: status === "sent" ? "outreach.sent" : "outreach.failed", outcome: status === "sent" ? "success" : "failure", requestId: randomUUID(), resourceType: "institution_outreach", resourceId: `${outreachId}:${status}:${String(fields.failureCode ?? "")}` });
    return { kind: "done" } as const;
  };

  if (delivery.status === "sending") return finish("failed", { failureCode: "UNKNOWN_DELIVERY_STATE", failedAt: now });
  if (delivery.status !== "queued") return { kind: "done" };

  const request = await EmergencyRequest.findById(record.requestId, { status: 1, expiresAt: 1, "automation.status": 1 }).lean();
  if (!request || !(OPEN_STATUSES as readonly string[]).includes(request.status) || request.expiresAt <= now || record.status === "cancelled") {
    return finish("suppressed", { failureCode: "REQUEST_CLOSED", failedAt: now });
  }
  // The address may have been corrected, marked invalid or unsubscribed since queueing.
  const institution = await Institution.findById(record.institutionId, { contactChannels: 1, verificationStatus: 1, "review.status": 1 }).lean();
  const channel = institution?.contactChannels.find((c) => c._id.equals(delivery.contactChannelId ?? new Types.ObjectId()));
  if (!institution || !channel || channel.value !== delivery.target || channel.status === "invalid" || channel.status === "opted_out" || institution.review?.status === "excluded" || ["rejected", "suspended"].includes(institution.verificationStatus)) {
    return finish("suppressed", { failureCode: "CONTACT_NO_LONGER_VALID", failedAt: now });
  }
  const provider = getEmailProvider();
  if (!provider) return finish("failed", { failureCode: "EMAIL_NOT_CONFIGURED", failedAt: now });

  const sentLastHour = await InstitutionOutreach.countDocuments({ deliveries: { $elemMatch: { channel: "email", status: "sent", sentAt: { $gte: new Date(now.getTime() - 60 * 60_000) } } } });
  if (sentLastHour >= getEmailConfig().maxPerHour) return { kind: "defer", until: new Date(now.getTime() + EMAIL_HOURLY_DEFER_MS) };

  const claimed = await InstitutionOutreach.updateOne({ _id: record._id, deliveries: { $elemMatch: { _id: delivery._id, status: "queued" } } }, { $set: { "deliveries.$.status": "sending" }, $inc: { "deliveries.$.attempts": 1 } });
  if (claimed.modifiedCount !== 1) return { kind: "done" };

  try {
    const { messageId } = await provider.send({
      to: delivery.target,
      subject: delivery.subject ?? "MarutiX emergency blood request",
      text: decryptPii(delivery.bodyEncrypted!),
      headers: { "X-MarutiX-Request": String(record.requestId) },
    });
    return finish("sent", { providerMessageId: messageId.slice(0, 200), sentAt: new Date() });
  } catch (error) {
    const retryable = error instanceof EmailSendError ? error.retryable : true;
    const code = error instanceof EmailSendError ? error.code : "SEND_FAILED";
    if (retryable && attempt.number < attempt.max) {
      await setDelivery({ status: "queued", failureCode: code });
      return { kind: "retry", error: error instanceof Error ? error : new Error(code) };
    }
    if (code === "INVALID_RECIPIENT" || code === "REJECTED") {
      await Institution.updateOne({ _id: record.institutionId, "contactChannels._id": delivery.contactChannelId }, { $set: { "contactChannels.$.status": "invalid", "contactChannels.$.statusChangedAt": now } });
    }
    return finish("failed", { failureCode: code, failedAt: new Date() });
  }
}

/* ------------------------------------------------------------------------ */
/* Responses from institutions                                              */
/* ------------------------------------------------------------------------ */

async function outreachForToken(token: string, now = new Date()) {
  await connectToDatabase();
  const record = (await InstitutionOutreach.findOne({ responseTokenHash: hashTrackingToken(token) }).lean()) as OutreachRecord | null;
  if (!record) throw new AppError(404, "NOT_FOUND", "This link isn't valid.");
  if (record.responseTokenExpiresAt && record.responseTokenExpiresAt <= now) throw new AppError(410, "TRACKING_LINK_EXPIRED", "This link has expired.");
  const [request, institution] = await Promise.all([
    EmergencyRequest.findById(record.requestId).lean() as Promise<RequestRecord | null>,
    Institution.findById(record.institutionId, { displayName: 1, contactChannels: 1 }).lean(),
  ]);
  if (!request || !institution) throw new AppError(404, "NOT_FOUND", "This link isn't valid.");
  return { record, request, institution };
}

/** What the institution sees on its secure link: the need, never the patient. */
export async function getOutreachPage(token: string) {
  const { record, request, institution } = await outreachForToken(token);
  return {
    institutionName: institution.displayName,
    publicRequestId: request.publicRequestId,
    open: (OPEN_STATUSES as readonly string[]).includes(request.status) && request.expiresAt > new Date(),
    verified: Boolean(request.verifiedAt),
    bloodGroup: request.bloodGroup,
    component: request.component,
    unitsRequested: request.unitsRequested,
    requiredBy: request.requiredBy.toISOString(),
    priority: request.priority,
    hospital: `${request.hospitalName}, ${request.locality}, ${request.city}`,
    coordinator: { phone: getCoordinationConfig().coordinatorPhone, email: getCoordinationConfig().coordinatorEmail },
    response: record.response?.status ? { status: record.response.status, at: record.response.at!.toISOString() } : null,
    emailOptOutAvailable: record.deliveries.some((d) => d.channel === "email"),
  };
}

async function applyResponse(record: OutreachRecord, request: RequestRecord, institutionName: string, response: InstitutionResponse, source: "secure_link" | "whatsapp" | "admin", extra: { contactName?: string; contactPhone?: string; note?: string; recordedBy?: Types.ObjectId }, now: Date) {
  await InstitutionOutreach.updateOne(
    { _id: record._id },
    {
      $set: {
        response: {
          status: response,
          at: now,
          source,
          ...(extra.contactName ? { contactNameEncrypted: encryptPii(extra.contactName) } : {}),
          ...(extra.contactPhone ? { contactPhoneEncrypted: encryptPii(extra.contactPhone) } : {}),
          ...(extra.note ? { note: extra.note } : {}),
          ...(extra.recordedBy ? { recordedBy: extra.recordedBy } : {}),
        },
        "followUp.status": response === "need_info" ? "needed" : "none",
      },
    },
  );
  await recordEvent(request._id, "institution_responded", `${institutionName}: ${INSTITUTION_RESPONSE_LABELS[response]}.`, { visibleToRequester: true, actor: source === "admin" ? "admin" : "institution", at: now });
  await recordAudit({ action: "outreach.response_recorded", outcome: "success", requestId: randomUUID(), actorUserId: extra.recordedBy, resourceType: "institution_outreach", resourceId: `${record._id.toString()}:${response}:${source}` });

  // Tell a verified WhatsApp requester when an institution says it may help.
  if (response === "can_assist" && request.createdVia === "whatsapp" && request.requesterPhoneEncrypted && (OPEN_STATUSES as readonly string[]).includes(request.status)) {
    await enqueueMessage({
      kind: "requester_update",
      templateName: "requester_institution_update_v1",
      phoneE164: decryptPii(request.requesterPhoneEncrypted),
      body: `MarutiX: ${institutionName} replied that it may be able to assist with ${request.publicRequestId}. This doesn't confirm stock. Please contact them directly${extra.contactPhone ? ` on ${extra.contactPhone}` : ""}, and keep your hospital informed.`,
      idempotencyKey: `requester_update:institution:${record._id.toString()}:${response}`,
      requestId: request._id.toString(),
      recordSuppressed: true,
    });
  }
}

export async function recordInstitutionResponse(token: string, body: { response: InstitutionResponse; contactName?: string; contactPhone?: string; note?: string }, now = new Date()) {
  const { record, request, institution } = await outreachForToken(token, now);
  if (!(OPEN_STATUSES as readonly string[]).includes(request.status)) throw new AppError(409, "INVALID_TRANSITION", "This request is closed. Thank you for responding.");
  await applyResponse(record, request, institution.displayName, body.response, "secure_link", body, now);
}

/** Stops MarutiX emails to the address(es) this link was sent to. */
export async function unsubscribeOutreachEmail(token: string, now = new Date()) {
  const { record } = await outreachForToken(token, now);
  const emails = record.deliveries.filter((d) => d.channel === "email").map((d) => d.target);
  for (const email of emails) {
    await Institution.updateOne({ _id: record.institutionId }, { $set: { "contactChannels.$[c].status": "opted_out", "contactChannels.$[c].statusChangedAt": now } }, { arrayFilters: [{ "c.type": "email", "c.value": email }] });
  }
  await recordAudit({ action: "outreach.email_unsubscribed", outcome: "success", requestId: randomUUID(), resourceType: "institution", resourceId: record.institutionId.toString() });
  return { unsubscribed: emails.length };
}

/** A verified institution contact answered on WhatsApp (ASSIST / UNABLE). */
export async function recordWhatsAppInstitutionResponse(request: RequestRecord, institutionId: Types.ObjectId, institutionName: string, response: InstitutionResponse, now = new Date()) {
  await InstitutionOutreach.updateOne(
    { requestId: request._id, institutionId },
    { $setOnInsert: { rank: 0, status: "sent", discoveredAt: now } },
    { upsert: true },
  );
  const record = (await InstitutionOutreach.findOne({ requestId: request._id, institutionId }).lean()) as OutreachRecord;
  await applyResponse(record, request, institutionName, response, "whatsapp", {}, now);
}

/* ------------------------------------------------------------------------ */
/* Admin                                                                    */
/* ------------------------------------------------------------------------ */

export async function listOutreach(requestObjectId: Types.ObjectId): Promise<OutreachView[]> {
  await connectToDatabase();
  const records = (await InstitutionOutreach.find({ requestId: requestObjectId }).sort({ rank: 1 }).limit(100).lean()) as OutreachRecord[];
  const institutions = await Institution.find({ _id: { $in: records.map((r) => r.institutionId) } }).lean();
  const byId = new Map(institutions.map((i) => [i._id.toString(), i]));
  return records.flatMap((r) => {
    const i = byId.get(r.institutionId.toString());
    if (!i) return [];
    return [{
      id: r._id.toString(),
      institutionId: i._id.toString(),
      name: i.displayName,
      capability: i.capability ?? "hospital",
      source: i.source ?? "admin",
      verificationStatus: i.verificationStatus,
      reviewStatus: i.review?.status ?? "approved",
      distanceKm: r.distanceKm ?? null,
      status: r.status,
      channels: (i.contactChannels ?? []).map((c) => ({ id: c._id.toString(), type: c.type, value: c.value, status: c.status, source: c.source, sourceUrl: c.sourceUrl ?? null, retrievedAt: c.retrievedAt.toISOString() })),
      deliveries: r.deliveries.map((d) => ({ channel: d.channel, target: d.target, status: d.status, failureCode: d.failureCode ?? null, sentAt: d.sentAt?.toISOString() ?? null })),
      response: r.response?.status
        ? {
            status: r.response.status,
            at: r.response.at!.toISOString(),
            source: r.response.source!,
            contactName: r.response.contactNameEncrypted ? decryptPii(r.response.contactNameEncrypted) : null,
            contactPhone: r.response.contactPhoneEncrypted ? decryptPii(r.response.contactPhoneEncrypted) : null,
            note: r.response.note ?? null,
          }
        : null,
      followUp: r.followUp?.status ?? "none",
    }];
  });
}

export async function adminOutreachAction(
  publicRequestId: string,
  outreachId: string,
  action: { action: "retry" | "send" | "cancel" } | { action: "record_response"; response: InstitutionResponse; note?: string },
  adminUserId: Types.ObjectId,
  requestId: string,
  now = new Date(),
) {
  await connectToDatabase();
  const request = (await EmergencyRequest.findOne({ publicRequestId }).lean()) as RequestRecord | null;
  if (!request || !Types.ObjectId.isValid(outreachId)) throw new AppError(404, "NOT_FOUND", "Outreach not found.");
  const record = (await InstitutionOutreach.findOne({ _id: outreachId, requestId: request._id }).lean()) as OutreachRecord | null;
  if (!record) throw new AppError(404, "NOT_FOUND", "Outreach not found.");
  const institution = await Institution.findById(record.institutionId, { displayName: 1 }).lean();

  switch (action.action) {
    case "record_response":
      await applyResponse(record, request, institution?.displayName ?? "Institution", action.response, "admin", { note: action.note, recordedBy: adminUserId }, now);
      break;
    case "cancel":
      await InstitutionOutreach.updateOne({ _id: record._id }, { $set: { status: "cancelled" } });
      break;
    case "retry":
    case "send": {
      if (!isAlertable(request.status)) throw new AppError(409, "NOT_RETRYABLE", "Outreach is only sent for active requests.");
      if (action.action === "retry" && record.status !== "failed") throw new AppError(409, "NOT_RETRYABLE", "Only failed outreach can be retried.");
      // Failed or never-contacted records start again; deliveries that went out are kept in the history below.
      const sentBefore = record.deliveries.filter((d) => d.status === "sent");
      await InstitutionOutreach.updateOne({ _id: record._id }, { $set: { status: "no_contact", deliveries: [] } });
      const result = await runOutreach(request._id.toString(), now);
      if (sentBefore.length) {
        await InstitutionOutreach.updateOne({ _id: record._id }, { $push: { deliveries: { $each: sentBefore, $position: 0 } } });
        await syncOutreachStatus(record._id);
      }
      if (!result.queued) {
        const after = await InstitutionOutreach.findById(record._id, { status: 1 }).lean();
        throw new AppError(409, "NOT_RETRYABLE", `Nothing could be sent: ${after?.status?.replace(/_/g, " ") ?? "no usable contact"}.`);
      }
      break;
    }
  }
  await recordAudit({ action: "outreach.changed", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "institution_outreach", resourceId: `${outreachId}:${action.action}` });
}
