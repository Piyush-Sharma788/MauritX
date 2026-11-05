import "server-only";
import { randomUUID } from "node:crypto";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import { formatIstShort } from "@/features/requests/parse";
import { COMPONENT_LABELS, createRequestSchema, isOpenStatus, OPEN_STATUSES, PUBLIC_REQUEST_ID, STATUS_LABELS } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { phoneLookupToken } from "@/lib/security/crypto";
import { parseYesNo } from "@/features/donors/parse";
import type { InboundMessage } from "@/server/conversations/bot";
import { advanceRequest, isRequestState, requestPrompt, startRequest, type RequestDraft, type RequestSnapshot } from "@/server/conversations/request-machine";
import { beginConversation, saveConversation, toFlowSnapshot, type ConversationRecord } from "@/server/conversations/store";
import { queueBotReplies } from "@/server/messaging/queue";
import { skipWelcomeImage } from "@/server/messaging/reply-context";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { User } from "@/server/models/user";
import { formatFacilitiesForWhatsApp, nearbyFacilitiesForRequest } from "@/server/discovery/nearby";
import { applyTransition, createRequest, expireOverdueRequests, type RequestRecord } from "@/server/requests/service";

/**
 * Patient and family flows on WhatsApp: REQUEST, TRACK and CANCEL. Requests
 * are created through the same service as the web form (validation,
 * duplicate detection, rate limits, encryption, pending verification). The
 * sender's number is authenticated by WhatsApp, so the sender gets the
 * private manage link; only that number can cancel the request here.
 */

const reply = (msg: InboundMessage, replies: string[]) => queueBotReplies(msg.fromE164, msg.providerMessageId, replies);
const ctxFor = () => ({ requestId: randomUUID(), ip: "whatsapp", userAgent: "whatsapp-bot" });

/* ------------------------------------------------------------------------ */
/* REQUEST                                                                  */
/* ------------------------------------------------------------------------ */

/** Starts a request conversation. `known` holds validated details from the first message, to be confirmed in the summary. */
export async function startRequestConversation(msg: InboundMessage, known: Partial<Omit<RequestDraft, "flowId">>, now: Date, lead?: string) {
  const phoneLookup = phoneLookupToken(msg.fromE164);
  const user = await User.findOne({ phoneLookup }, { displayName: 1 }).lean();
  const prefill: Partial<Omit<RequestDraft, "flowId">> = {
    ...known,
    // Already known and verified: the WhatsApp number this request comes from.
    contactPhone: msg.fromE164,
    ...(user?.displayName && !known.contactName ? { contactName: user.displayName } : {}),
  };
  const { snapshot, replies } = startRequest(randomUUID(), prefill, { senderE164: msg.fromE164, now });
  await beginConversation({ phoneLookup, snapshot, now });
  // In an emergency the questions (and the call-112 advice) must not wait behind an image.
  skipWelcomeImage();
  await reply(msg, lead ? [lead, ...replies] : replies);
}

export async function continueRequestConversation(conversation: ConversationRecord, msg: InboundMessage, now: Date): Promise<"continue" | "created" | "cancelled" | "failed"> {
  const raw = toFlowSnapshot<string, RequestDraft>(conversation);
  const snapshot: RequestSnapshot = {
    flow: "emergency_request",
    state: isRequestState(raw.state) ? raw.state : "patient_name",
    history: raw.history.filter(isRequestState),
    data: raw.data,
  };
  const ctx = { senderE164: msg.fromE164, now };
  const resumed = conversation.lastInboundAt && now.getTime() - conversation.lastInboundAt.getTime() > 60 * 60 * 1000;
  const outcome = advanceRequest(snapshot, msg.input, ctx);

  if (outcome.type === "continue") {
    await saveConversation(conversation, { snapshot: outcome.snapshot, status: "active", now });
    const repeated = outcome.snapshot === snapshot;
    await reply(msg, resumed && repeated ? ["Welcome back! Let's continue your blood request.", requestPrompt(snapshot, ctx)] : outcome.replies);
    return "continue";
  }
  if (outcome.type === "cancelled") {
    await saveConversation(conversation, { status: "cancelled", now });
    await reply(msg, outcome.replies);
    return "cancelled";
  }

  // Confirmed with YES. Validate once more with the same schema as the web form.
  const d = outcome.draft;
  const parsed = createRequestSchema.safeParse({
    patientName: d.patientName,
    patientAge: d.patientAge,
    contactName: d.contactName,
    contactPhone: d.contactPhone,
    bloodGroup: d.bloodGroup,
    component: d.component,
    unitsRequested: d.unitsRequested,
    requiredBy: d.requiredBy,
    priority: d.priority,
    hospitalName: d.hospitalName,
    hospitalAddress: d.hospitalAddress,
    city: d.city,
    locality: d.locality,
    hospitalPhone: null,
    location: d.location,
    whatsappUpdates: false,
    consent: true,
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
  });
  if (!parsed.success) {
    logger.warn("whatsapp.request_validation_failed", { field: parsed.error.issues[0]?.path.join(".") });
    await saveConversation(conversation, { snapshot: { ...snapshot, state: "confirm" }, status: "active", now });
    await reply(msg, ["Some details need another look. Reply the number of the detail to change it.", requestPrompt({ ...snapshot, state: "confirm" }, ctx)]);
    return "failed";
  }

  try {
    const created = await createRequest(parsed.data, `wa-${d.flowId}`, ctxFor(), now, { channel: "whatsapp", requesterE164: msg.fromE164 });
    await saveConversation(conversation, { status: "completed", now });
    await reply(msg, [
      [
        `✅ Request ${created.publicRequestId} submitted.`,
        "Status: Pending verification. Our team verifies every request with the hospital before any donor is alerted.",
        "",
        "Your private link to track, update or cancel (don't forward it):",
        created.manageUrl,
        "",
        "Reply TRACK to check the status here, or CANCEL to cancel it.",
        "MarutiX doesn't guarantee blood availability. Stay in touch with the hospital's blood bank, and call 112 if life is at risk.",
      ].join("\n"),
      ...(await nearbyFacilitiesText(created.publicRequestId)),
    ]);
    return "created";
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await saveConversation(conversation, { status: "cancelled", now });
    const message =
      error.code === "DUPLICATE_REQUEST"
        ? "You already have an open request for the same patient need at this hospital. Reply TRACK to see it."
        : error.code === "RATE_LIMITED"
          ? "Too many requests have been created from this number today. Please call the hospital's blood bank directly, or contact MarutiX support."
          : "We couldn't submit the request. Please try again, or use the website.";
    await reply(msg, [message]);
    return "failed";
  }
}

/* ------------------------------------------------------------------------ */
/* TRACK                                                                    */
/* ------------------------------------------------------------------------ */

const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

function describe(r: RequestRecord): string {
  const stats = r.responseStats ?? { interested: 0 };
  return [
    `${r.publicRequestId}: ${STATUS_LABELS[r.status]}`,
    `${r.bloodGroup === "unknown" ? "Blood group to be confirmed" : BLOOD_GROUP_LABELS[r.bloodGroup]} · ${r.unitsRequested} × ${COMPONENT_LABELS[r.component]} · needed by ${formatIstShort(r.requiredBy)}`,
    `Hospital: ${r.hospitalName}, ${r.locality}`,
    `Verified by MarutiX: ${r.verifiedAt ? "Yes" : "Not yet"}`,
    ...(isOpenStatus(r.status) && r.status !== "pending_verification"
      ? [`Donors who said they're interested: ${stats.interested ?? 0} (interest isn't a confirmed donation)`]
      : []),
    `Last update: ${formatIstShort(r.updatedAt)}`,
  ].join("\n");
}

/**
 * The nearest known blood banks and hospitals (verified first, others labelled unverified),
 * from MarutiX's own records only. Empty when none are known yet, and never allowed to
 * stop the confirmation itself.
 */
async function nearbyFacilitiesText(publicRequestId: string): Promise<string[]> {
  try {
    const result = await nearbyFacilitiesForRequest(publicRequestId, { limit: 3 });
    if (!result?.facilities.length) return [];
    return [`Blood banks and hospitals near the hospital you named:\n${formatFacilitiesForWhatsApp(result)}`];
  } catch (error) {
    logger.warn("whatsapp.nearby_facilities_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return [];
  }
}

/** Requests this number created on WhatsApp or is the contact for. Status only, never patient details. */
export async function trackRequests(msg: InboundMessage, publicRequestId: string | null, now = new Date()) {
  await connectToDatabase();
  await expireOverdueRequests(now);
  const lookup = phoneLookupToken(msg.fromE164);
  const filter: Record<string, unknown> = {
    $or: [{ requesterPhoneLookup: lookup }, { contactPhoneLookup: lookup }],
    ...(publicRequestId ? { publicRequestId } : { $and: [{ $or: [{ status: { $in: OPEN_STATUSES } }, { updatedAt: { $gte: new Date(now.getTime() - RECENT_MS) } }] }] }),
  };
  const requests = (await EmergencyRequest.find(filter).sort({ createdAt: -1 }).limit(3).lean()) as RequestRecord[];
  if (requests.length === 0) {
    await reply(msg, [
      publicRequestId
        ? "We couldn't find that request for this number. Requests can be tracked from the number that created them or the contact number given."
        : "We couldn't find a recent blood request for this number. Reply REQUEST to create one, or use the tracking link you saved if you used the website.",
    ]);
    return;
  }
  await reply(msg, [requests.map(describe).join("\n\n"), "For full details use your tracking link. In a medical emergency, call 112."]);
}

/* ------------------------------------------------------------------------ */
/* CANCEL                                                                   */
/* ------------------------------------------------------------------------ */

interface CancelData {
  options: string[];
  selected?: string;
}

const cancelPrompt = (r: Pick<RequestRecord, "publicRequestId" | "bloodGroup" | "hospitalName">) =>
  `Cancel request ${r.publicRequestId} (${r.bloodGroup === "unknown" ? "blood" : BLOOD_GROUP_LABELS[r.bloodGroup]} at ${r.hospitalName})? Reply YES to cancel it, or NO to keep it.`;

/** CANCEL only applies to open requests created on WhatsApp from this same number. */
export async function startCancel(msg: InboundMessage, publicRequestId: string | null, now: Date) {
  await connectToDatabase();
  await expireOverdueRequests(now);
  const lookup = phoneLookupToken(msg.fromE164);
  const open = (await EmergencyRequest.find({ requesterPhoneLookup: lookup, status: { $in: OPEN_STATUSES }, ...(publicRequestId ? { publicRequestId } : {}) })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean()) as RequestRecord[];

  if (open.length === 0) {
    const asContact = await EmergencyRequest.exists({ contactPhoneLookup: lookup, status: { $in: OPEN_STATUSES } });
    await reply(msg, [
      asContact
        ? "Requests made on the website can only be cancelled with their private tracking link, so a mistyped number can't cancel someone else's request. Open your link and choose Cancel."
        : "You don't have an open request created from this WhatsApp number.",
    ]);
    return;
  }
  const data: CancelData = { options: open.map((r) => r.publicRequestId), ...(open.length === 1 ? { selected: open[0].publicRequestId } : {}) };
  const state = open.length === 1 ? "confirm" : "choose";
  await beginConversation({ phoneLookup: lookup, snapshot: { flow: "request_cancel", state, history: [], data }, now });
  await reply(msg, [
    open.length === 1
      ? cancelPrompt(open[0])
      : ["Which request do you want to cancel?", ...open.map((r, i) => `${i + 1}. ${r.publicRequestId} (${r.hospitalName})`), "Reply with a number, or NO to keep them all."].join("\n"),
  ]);
}

export async function continueCancel(conversation: ConversationRecord, msg: InboundMessage, now: Date) {
  const snapshot = toFlowSnapshot<"choose" | "confirm", CancelData>(conversation);
  const text = msg.input.type === "text" ? msg.input.text.trim() : "";
  const end = async (message: string, status: "completed" | "cancelled") => {
    await saveConversation(conversation, { status, now });
    await reply(msg, [message]);
  };
  const keep = /^(no|n|nahi|nahin|keep( it)?)$/i.test(text) || (snapshot.state === "confirm" && parseYesNo(text) === false);
  if (keep) return end("OK, nothing was cancelled.", "cancelled");

  if (snapshot.state === "choose") {
    const choice = Number(text);
    const selected = Number.isInteger(choice) ? snapshot.data.options[choice - 1] : undefined;
    if (!selected) {
      await saveConversation(conversation, { snapshot, status: "active", now });
      await reply(msg, ["Please reply with one of the numbers, or NO."]);
      return;
    }
    const r = await EmergencyRequest.findOne({ publicRequestId: selected }, { publicRequestId: 1, bloodGroup: 1, hospitalName: 1 }).lean();
    await saveConversation(conversation, { snapshot: { ...snapshot, state: "confirm", data: { ...snapshot.data, selected } }, status: "active", now });
    await reply(msg, [r ? cancelPrompt(r) : "Reply YES to cancel it, or NO to keep it."]);
    return;
  }

  if (parseYesNo(text) !== true || !snapshot.data.selected) {
    await saveConversation(conversation, { snapshot, status: "active", now });
    await reply(msg, ["Reply YES to cancel the request, or NO to keep it."]);
    return;
  }

  const lookup = phoneLookupToken(msg.fromE164);
  const request = (await EmergencyRequest.findOne({ publicRequestId: snapshot.data.selected }).lean()) as RequestRecord | null;
  // Re-check ownership and state at the moment of cancelling.
  if (!request || request.requesterPhoneLookup !== lookup || !PUBLIC_REQUEST_ID.test(request.publicRequestId)) {
    return end("We couldn't cancel that request from this number.", "cancelled");
  }
  try {
    await applyTransition(request, "cancelled", { type: "requester", note: "Cancelled on WhatsApp" }, ctxFor(), now);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return end(`${request.publicRequestId} can't be cancelled now: it is ${STATUS_LABELS[request.status].toLowerCase()}.`, "cancelled");
  }
  return end(`Request ${request.publicRequestId} is cancelled. Any pending donor alerts were withdrawn. We hope the patient is doing well.`, "completed");
}

/** Extracts an "MX-XXXXXXXX" reference from free text, if there is one. */
export function findRequestId(text: string): string | null {
  const m = /\bMX-?([0-9A-HJKMNP-TV-Z]{8})\b/i.exec(text);
  return m ? `MX-${m[1].toUpperCase()}` : null;
}
