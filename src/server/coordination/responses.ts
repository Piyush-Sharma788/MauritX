import "server-only";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { ALERTABLE_STATUSES, type CoordinationStatus, type DonorResponse } from "@/features/coordination/schemas";
import type { CoordinationSummary, ResponseView } from "@/features/coordination/types";
import { parseYesNo } from "@/features/donors/parse";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import { COMPONENT_LABELS, STATUS_LABELS } from "@/features/requests/schemas";
import type { MessageStatus } from "@/features/whatsapp/types";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, phoneLookupToken } from "@/lib/security/crypto";
import type { InboundMessage } from "@/server/conversations/bot";
import { beginConversation, saveConversation, toFlowSnapshot, type ConversationRecord } from "@/server/conversations/store";
import { allowedCoordination, canAdvanceCoordination } from "@/server/coordination/status";
import { recordOptOut } from "@/server/messaging/opt-out";
import { queueBotReplies, queueCoordinatorAlert, queueSystemReply } from "@/server/messaging/queue";
import { formatNeededBy } from "@/server/messaging/templates";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";
import { NotificationEvent } from "@/server/models/notification-event";
import { RequestResponse } from "@/server/models/request-response";
import { User } from "@/server/models/user";
import { recordAudit } from "@/server/services/audit";
import { getMessagingSettings } from "@/server/settings/service";

/**
 * Donor replies to emergency alerts and what happens after them. A reply is
 * tied to the donor's most recent alert (or an explicit MX- reference),
 * recorded once per (request, donor), and passed to the coordinators. Interest
 * is never a donation: only a coordinator or verified institution confirms one.
 */

const ALERT_REPLY_WINDOW_MS = 72 * 60 * 60 * 1000;
const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;
const isAlertable = (s: string) => (ALERTABLE_STATUSES as readonly string[]).includes(s);

export type AlertReply = DonorResponse | "more_info" | "stop";

/** Text that answers an alert: the numbered options and their common words. */
export function parseAlertReply(text: string): AlertReply | null {
  const t = text.trim().toUpperCase().replace(/\s+/g, " ").replace(/\bMX-?[0-9A-Z]{8}\b/, "").trim();
  if (/^(1|INTERESTED|I'?M INTERESTED|I CAN HELP|I CAN DONATE|AVAILABLE|YES I CAN)$/.test(t)) return "interested";
  if (/^(2|UNAVAILABLE|NOT AVAILABLE|CAN'?T|CANNOT|BUSY)$/.test(t)) return "unavailable";
  if (/^(3|MORE INFO|MORE INFORMATION|INFO|DETAILS)$/.test(t)) return "more_info";
  if (/^(4|STOP ALERTS)$/.test(t)) return "stop";
  return null;
}

interface AlertContext {
  donorUserId: Types.ObjectId;
  notificationId: Types.ObjectId;
  request: NonNullable<Awaited<ReturnType<typeof loadRequest>>>;
}

const loadRequest = (filter: Record<string, unknown>) => EmergencyRequest.findOne(filter).lean();

/** The alert a reply refers to: an explicit request ID, or the donor's most recent delivered alert. */
export async function findAlertContext(phoneE164: string, publicRequestId: string | null, now = new Date()): Promise<AlertContext | null> {
  await connectToDatabase();
  const user = await User.findOne({ phoneLookup: phoneLookupToken(phoneE164) }, { _id: 1 }).lean();
  if (!user) return null;
  const delivered: MessageStatus[] = ["sent", "delivered", "read"];
  const sent = { recipientUserId: user._id, kind: "emergency_request" as const, status: { $in: delivered } };
  let alert;
  if (publicRequestId) {
    const request = await loadRequest({ publicRequestId });
    if (!request) return null;
    alert = await NotificationEvent.findOne({ ...sent, requestId: request._id.toString() }).sort({ createdAt: -1 }).lean();
    return alert ? { donorUserId: user._id, notificationId: alert._id, request } : null;
  }
  alert = await NotificationEvent.findOne({ ...sent, createdAt: { $gte: new Date(now.getTime() - ALERT_REPLY_WINDOW_MS) } }).sort({ createdAt: -1 }).lean();
  if (!alert?.requestId || !Types.ObjectId.isValid(alert.requestId)) return null;
  const request = await loadRequest({ _id: alert.requestId });
  return request ? { donorUserId: user._id, notificationId: alert._id, request } : null;
}

/** Records one donor's answer, once per (request, donor). A changed answer replaces the old one. */
export async function recordDonorResponse(
  context: AlertContext,
  response: DonorResponse,
  now = new Date(),
): Promise<{ outcome: "created" | "duplicate" | "changed"; responseId: Types.ObjectId }> {
  const { request, donorUserId } = context;
  const statKey = (r: DonorResponse) => `responseStats.${r}`;
  try {
    const created = await RequestResponse.create({
      requestId: request._id,
      donorUserId,
      notificationId: context.notificationId,
      response,
      respondedAt: now,
      ...(response === "interested" ? { coordinationStatus: "interested", coordinationHistory: [{ status: "interested", at: now, actor: "donor" }] } : {}),
    });
    await EmergencyRequest.updateOne({ _id: request._id }, { $inc: { [statKey(response)]: 1 } });
    await recordAudit({ action: "response.recorded", outcome: "success", requestId: randomUUID(), actorUserId: donorUserId, resourceType: "emergency_request", resourceId: `${request.publicRequestId}:${response}` });
    return { outcome: "created", responseId: created._id };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const existing = await RequestResponse.findOne({ requestId: request._id, donorUserId }).lean();
  if (!existing) throw new Error("Response vanished after a duplicate key error");
  if (existing.response === response) return { outcome: "duplicate", responseId: existing._id };

  const changeSet: Record<string, unknown> = { response, respondedAt: now };
  const push: Record<string, unknown> = {};
  if (response === "unavailable" && existing.coordinationStatus && existing.coordinationStatus !== "donation_confirmed") {
    changeSet.coordinationStatus = "not_proceeding";
    push.coordinationHistory = { status: "not_proceeding", at: now, actor: "donor", note: "Donor replied unavailable" };
  } else if (response === "interested") {
    changeSet.coordinationStatus = "interested";
    push.coordinationHistory = { status: "interested", at: now, actor: "donor" };
  }
  // Conditional on the old answer, so two concurrent replies can't both count.
  const result = await RequestResponse.updateOne(
    { _id: existing._id, response: existing.response },
    { $set: changeSet, ...(Object.keys(push).length ? { $push: push } : {}) },
  );
  if (result.modifiedCount !== 1) return { outcome: "duplicate", responseId: existing._id };
  await EmergencyRequest.updateOne({ _id: request._id }, { $inc: { [statKey(response)]: 1, [statKey(existing.response)]: -1 } });
  await recordAudit({ action: "response.recorded", outcome: "success", requestId: randomUUID(), actorUserId: donorUserId, resourceType: "emergency_request", resourceId: `${request.publicRequestId}:${existing.response}->${response}` });
  return { outcome: "changed", responseId: existing._id };
}

function moreInfoText(r: AlertContext["request"]): string {
  return [
    `MarutiX request ${r.publicRequestId}`,
    `Status: ${STATUS_LABELS[r.status]}${r.verifiedAt ? " (verified by MarutiX with the hospital)" : ""}`,
    `Blood: ${r.bloodGroup === "unknown" ? "group to be confirmed by the hospital" : BLOOD_GROUP_LABELS[r.bloodGroup]} · ${r.unitsRequested} × ${COMPONENT_LABELS[r.component]}`,
    `Required by: ${formatNeededBy(r.requiredBy)}`,
    `Hospital: ${r.hospitalName}`,
    `Address: ${r.hospitalAddress}, ${r.locality}, ${r.city}`,
    "",
    "If you can help, reply 1. A coordinator will tell you where to go. Please don't go to the hospital unless they ask you to.",
    "Only the blood centre can decide whether you can donate.",
  ].join("\n");
}

const SHARE_PROMPT =
  "May we share your name and WhatsApp number with the MarutiX coordinator and the hospital's blood bank for this request only? Reply YES or NO. (If you say NO, the MarutiX team will contact you instead.)";

/**
 * Handles an alert reply. Returns false when there's no alert it could refer
 * to, so the message falls through to the normal bot.
 */
export async function handleAlertReply(msg: InboundMessage, reply: AlertReply, publicRequestId: string | null, now = new Date()): Promise<boolean> {
  const context = await findAlertContext(msg.fromE164, publicRequestId, now);
  if (!context) return false;
  const send = (texts: string[]) => queueBotReplies(msg.fromE164, msg.providerMessageId, texts, context.donorUserId);

  if (reply === "stop") {
    await recordOptOut(msg.fromE164, "whatsapp_stop", now);
    await queueSystemReply("opt_out_confirmation", msg.fromE164, now);
    return true;
  }
  if (!isAlertable(context.request.status) || context.request.expiresAt <= now) {
    await send([`Thank you for replying. Request ${context.request.publicRequestId} no longer needs donors (${STATUS_LABELS[context.request.status].toLowerCase()}). We'll let you know if someone nearby needs help.`]);
    return true;
  }
  if (reply === "more_info") {
    await send([moreInfoText(context.request)]);
    return true;
  }

  const { outcome, responseId } = await recordDonorResponse(context, reply, now);
  if (outcome === "duplicate") {
    await send([`We already have your reply for ${context.request.publicRequestId}. Thank you! Reply ${reply === "interested" ? "2 if you can no longer help" : "1 if you can help after all"}.`]);
    return true;
  }
  if (reply === "unavailable") {
    await send([`Thanks for letting us know. We won't ask you about ${context.request.publicRequestId} again. You'll still get alerts for other requests nearby; reply PAUSE to pause them.`]);
    if (outcome === "changed") await notifyCoordinators(context.request, responseId, context.donorUserId, "withdrawn");
    return true;
  }
  await beginConversation({
    phoneLookup: phoneLookupToken(msg.fromE164),
    snapshot: { flow: "donor_response", state: "share_consent", history: [], data: { responseId: responseId.toString(), publicRequestId: context.request.publicRequestId } },
    userId: context.donorUserId,
    now,
  });
  await send([`Thank you! 🙏 Your interest in ${context.request.publicRequestId} is recorded. This isn't a confirmed donation yet.`, SHARE_PROMPT]);
  return true;
}

/** The donor answers whether their contact may be shared. */
export async function continueDonorResponse(conversation: ConversationRecord, msg: InboundMessage, now = new Date()) {
  const snapshot = toFlowSnapshot<"share_consent", { responseId: string; publicRequestId: string }>(conversation);
  const answer = msg.input.type === "text" ? parseYesNo(msg.input.text) : null;
  const send = (texts: string[]) => queueBotReplies(msg.fromE164, msg.providerMessageId, texts, conversation.userId ?? undefined);
  if (answer === null) {
    await saveConversation(conversation, { snapshot, status: "active", now });
    await send(["Please reply YES to share your name and number for this request, or NO to keep them private."]);
    return;
  }
  const response = Types.ObjectId.isValid(snapshot.data.responseId) ? await RequestResponse.findById(snapshot.data.responseId).lean() : null;
  await saveConversation(conversation, { status: "completed", now });
  if (!response) {
    await send(["Thank you. The MarutiX team will contact you if you're needed."]);
    return;
  }
  await RequestResponse.updateOne(
    { _id: response._id },
    answer ? { $set: { contactSharingConsentAt: now }, $unset: { contactSharingDeclinedAt: 1 } } : { $set: { contactSharingDeclinedAt: now }, $unset: { contactSharingConsentAt: 1 } },
  );
  const request = await EmergencyRequest.findById(response.requestId).lean();
  if (request) await notifyCoordinators(request, response._id, response.donorUserId, answer ? "shared" : "private");
  await send([
    [
      answer ? "Thank you. The coordinator and hospital blood bank can now contact you about this request." : "Understood. Your number stays private; the MarutiX team will contact you if you're needed.",
      "Next steps:",
      "• Please don't go to the hospital until a coordinator asks you to.",
      "• Carry a photo ID. The blood centre will check whether you can donate (health, haemoglobin and screening).",
      "• If you can't help any more, reply 2.",
    ].join("\n"),
  ]);
}

/** Tells the request's verified institution coordinators about a response. Without a linked institution, the admin dashboard is the coordinator's view. */
async function notifyCoordinators(
  request: NonNullable<Awaited<ReturnType<typeof loadRequest>>>,
  responseId: Types.ObjectId,
  donorUserId: Types.ObjectId,
  kind: "shared" | "private" | "withdrawn",
): Promise<number> {
  if (!request.institutionId) return 0;
  const institution = await Institution.findOne({ _id: request.institutionId, verificationStatus: "verified" }, { _id: 1 }).lean();
  if (!institution) return 0;
  const contacts = await InstitutionContact.find({ institutionId: institution._id, status: "verified" }).lean();
  if (contacts.length === 0) return 0;

  const donor = await User.findById(donorUserId, { displayName: 1, phoneEncrypted: 1 }).lean();
  const firstName = donor?.displayName?.split(" ")[0] ?? "A donor";
  const header = `MarutiX: donor update for ${request.publicRequestId} (${request.bloodGroup === "unknown" ? "blood group to be confirmed" : request.bloodGroup}, ${COMPONENT_LABELS[request.component]}).`;
  const body =
    kind === "withdrawn"
      ? `${header}\nA donor who was interested is no longer available.`
      : kind === "shared"
        ? `${header}\n${firstName}, a registered donor, is interested and agreed to share their number: ${decryptPii(donor!.phoneEncrypted)}\nInterest isn't a confirmed donation; please screen as usual. Reply STATUS ${request.publicRequestId} for the request status.`
        : `${header}\nA registered donor is interested but chose not to share their number. The MarutiX team will coordinate with them.`;

  let queued = 0;
  for (const contact of contacts) {
    const result = await queueCoordinatorAlert({
      requestId: request._id.toString(),
      phoneE164: decryptPii(contact.phoneEncrypted),
      body,
      idempotencyKey: `${responseId.toString()}:${contact._id.toString()}:${kind}`,
    });
    if (result.outcome === "queued") queued += 1;
  }
  return queued;
}

/* ------------------------------------------------------------------------ */
/* Admin                                                                    */
/* ------------------------------------------------------------------------ */

export async function listResponses(requestObjectId: Types.ObjectId): Promise<ResponseView[]> {
  await connectToDatabase();
  const responses = await RequestResponse.find({ requestId: requestObjectId }).sort({ respondedAt: -1 }).limit(100).lean();
  const users = await User.find({ _id: { $in: responses.map((r) => r.donorUserId) } }, { displayName: 1, phoneEncrypted: 1 }).lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  return responses.map((r) => {
    const user = byId.get(r.donorUserId.toString());
    return {
      id: r._id.toString(),
      donorFirstName: user?.displayName?.split(" ")[0] ?? "Donor",
      donorPhone: r.contactSharingConsentAt && user ? decryptPii(user.phoneEncrypted) : null,
      contactSharing: r.contactSharingConsentAt ? "consented" : r.contactSharingDeclinedAt ? "declined" : "pending",
      response: r.response,
      coordinationStatus: r.coordinationStatus ?? null,
      allowedNext: allowedCoordination(r.coordinationStatus),
      respondedAt: r.respondedAt.toISOString(),
      history: (r.coordinationHistory ?? []).map((h) => ({ status: h.status, at: h.at.toISOString(), actor: h.actor, note: h.note ?? null })),
    };
  });
}

export async function updateCoordination(
  publicRequestId: string,
  responseId: string,
  to: CoordinationStatus,
  actor: { type: "admin"; userId: Types.ObjectId } | { type: "institution"; contactId: Types.ObjectId; institutionId: Types.ObjectId },
  note: string | undefined,
  requestId: string,
  now = new Date(),
): Promise<void> {
  await connectToDatabase();
  const request = await EmergencyRequest.findOne({ publicRequestId }, { _id: 1, institutionId: 1 }).lean();
  if (!request || !Types.ObjectId.isValid(responseId)) throw new AppError(404, "NOT_FOUND", "Response not found.");
  if (actor.type === "institution" && request.institutionId?.toString() !== actor.institutionId.toString()) {
    throw new AppError(404, "NOT_FOUND", "Response not found.");
  }
  const response = await RequestResponse.findOne({ _id: responseId, requestId: request._id }).lean();
  if (!response) throw new AppError(404, "NOT_FOUND", "Response not found.");
  if (!canAdvanceCoordination(response.coordinationStatus, to)) {
    throw new AppError(409, "INVALID_TRANSITION", "That step isn't possible from the response's current state.");
  }
  const entry = {
    status: to,
    at: now,
    actor: actor.type,
    ...(actor.type === "admin" ? { actorUserId: actor.userId } : { actorContactId: actor.contactId }),
    ...(note ? { note } : {}),
  };
  const result = await RequestResponse.updateOne(
    { _id: response._id, coordinationStatus: response.coordinationStatus },
    { $set: { coordinationStatus: to }, $push: { coordinationHistory: entry } },
  );
  if (result.modifiedCount !== 1) throw new AppError(409, "CONFLICT", "This response was just updated. Refresh and try again.");
  await recordAudit({
    action: "response.coordination_updated",
    outcome: "success",
    requestId,
    actorUserId: actor.type === "admin" ? actor.userId : undefined,
    resourceType: "request_response",
    resourceId: `${publicRequestId}:${response.coordinationStatus}->${to}`,
  });
}

export async function coordinationSummary(request: { _id: Types.ObjectId; status: string; expiresAt: Date; institutionId?: Types.ObjectId | null; institutionAcknowledgedAt?: Date | null }): Promise<CoordinationSummary> {
  await connectToDatabase();
  const [alertRows, responseRows, institution, settings] = await Promise.all([
    NotificationEvent.aggregate<{ _id: string; count: number }>([
      { $match: { requestId: request._id.toString(), kind: "emergency_request" } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    RequestResponse.aggregate<{ _id: { response: string; coordination: string | null }; count: number }>([
      { $match: { requestId: request._id } },
      { $group: { _id: { response: "$response", coordination: "$coordinationStatus" }, count: { $sum: 1 } } },
    ]),
    request.institutionId ? Institution.findById(request.institutionId, { displayName: 1 }).lean() : null,
    getMessagingSettings(),
  ]);
  const alerts = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 };
  for (const row of alertRows) {
    if (row._id === "sending") alerts.queued += row.count;
    else if (row._id in alerts) alerts[row._id as keyof typeof alerts] += row.count;
  }
  let interested = 0;
  let unavailable = 0;
  let donationsConfirmed = 0;
  for (const row of responseRows) {
    if (row._id.response === "interested") interested += row.count;
    if (row._id.response === "unavailable") unavailable += row.count;
    if (row._id.coordination === "donation_confirmed") donationsConfirmed += row.count;
  }
  return {
    alerts,
    interested,
    unavailable,
    donationsConfirmed,
    institution: institution
      ? { id: institution._id.toString(), displayName: institution.displayName, acknowledgedAt: request.institutionAcknowledgedAt?.toISOString() ?? null }
      : null,
    alertsPaused: settings.alertsPaused,
    alertable: isAlertable(request.status) && request.expiresAt > new Date(),
  };
}
