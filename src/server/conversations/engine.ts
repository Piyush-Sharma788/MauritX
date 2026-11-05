import "server-only";
import { randomUUID } from "node:crypto";
import { parseBloodGroup } from "@/features/donors/parse";
import { parseComponent, parseRequiredBy } from "@/features/requests/parse";
import { hospitalStepSchema, OPEN_STATUSES } from "@/features/requests/schemas";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { phoneLookupToken } from "@/lib/security/crypto";
import { interpretMessage, safeSuggestedReply } from "@/server/ai/interpret";
import type { AiMessageContext } from "@/server/ai/provider";
import type { Interpretation } from "@/server/ai/schema";
import { handleBotMessage, REGISTER_WORDS, replyToDonorStart, RESUBSCRIBED_TEXT, START_WORDS, type InboundMessage } from "@/server/conversations/bot";
import { closeMainMenu, isMenuConversation, menuNotUnderstood, showMainMenu } from "@/server/conversations/main-menu";
import { MENU_DECLINED_TEXT, MENU_WORDS, parseMenuChoice, type MenuChoice } from "@/server/conversations/menu";
import { requiredByInRange, type RequestDraft } from "@/server/conversations/request-machine";
import { beginConversation, ConversationConflictError, isDonorFlow, loadConversation, saveConversation, type ConversationRecord } from "@/server/conversations/store";
import { continueDonorResponse, findAlertContext, handleAlertReply, parseAlertReply } from "@/server/coordination/responses";
import { handleInstitutionCommand } from "@/server/institutions/whatsapp";
import { isOptedOut, verifiedInstitutionContact } from "@/server/messaging/eligibility";
import { liftOptOut } from "@/server/messaging/opt-out";
import { queueBotReplies } from "@/server/messaging/queue";
import { runWithReplyContext, currentReplyContext } from "@/server/messaging/reply-context";
import { HELP_TEXT } from "@/server/messaging/templates";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { User } from "@/server/models/user";
import { continueCancel, continueRequestConversation, findRequestId, startCancel, startRequestConversation, trackRequests } from "@/server/requests/whatsapp";
import { recordAudit } from "@/server/services/audit";

/**
 * The WhatsApp conversation engine. Every inbound message (after dedupe,
 * rate limiting and STOP, see messaging/inbound.ts) comes here and is routed:
 *
 * 0. After STOP only REGISTER/START/JOIN get through. MENU opens the
 *    first-contact menu from anywhere; BACK at a flow's first question
 *    returns to it. While the menu is open, its options (1-4, the command
 *    words, YES/NO, Hindi) pick a flow; a numbered reply to a fresh
 *    emergency alert still counts as the alert reply.
 * 1. An active flow (request, cancellation, alert reply, donor registration
 *    or update) continues. REQUEST is the one command that interrupts any
 *    flow, because an emergency outranks everything else.
 * 2. Verified institution contacts' commands.
 * 3. Patient commands: REQUEST, TRACK, CANCEL.
 * 4. Replies to an emergency alert (1–4, INTERESTED, ...).
 * 5. Donor commands and the donor bot (REGISTER, PROFILE, STATUS, ...).
 * 6. Free text: AI (or keywords) proposes an intent; the engine maps it to
 *    the same deterministic handlers, and anything that changes data or
 *    consent is turned into a question the person must confirm themselves.
 */

export type Route =
  | "flow"
  | "institution"
  | "request"
  | "track"
  | "cancel"
  | "alert_reply"
  | "donor"
  | "ai"
  | "keywords"
  | "menu"
  | "ignored";

const REQUEST_WORDS = new Set(["REQUEST", "NEED BLOOD", "BLOOD REQUEST", "EMERGENCY", "NEW REQUEST"]);
const DONOR_WORDS = new Set(["REGISTER", "JOIN", "SIGN UP", "SIGNUP", "DONATE", "DONOR", "HELP", "STATUS", "PROFILE", "MY PROFILE", "UPDATE", "EDIT", "PAUSE", "RESUME"]);
const BACK_WORDS = new Set(["BACK", "PREVIOUS"]);
const keywordOf = (msg: InboundMessage) => (msg.input.type === "text" ? msg.input.text.trim().toUpperCase().replace(/\s+/g, " ") : "");
const firstWord = (k: string) => k.split(" ")[0];

const withText = (msg: InboundMessage, text: string): InboundMessage => ({ ...msg, input: { type: "text", text } });

async function senderContext(phoneE164: string, now: Date): Promise<AiMessageContext> {
  const lookup = phoneLookupToken(phoneE164);
  const [institution, user, openRequest, alert] = await Promise.all([
    verifiedInstitutionContact(lookup),
    User.findOne({ phoneLookup: lookup }, { _id: 1 }).lean(),
    EmergencyRequest.exists({ $or: [{ requesterPhoneLookup: lookup }, { contactPhoneLookup: lookup }], status: { $in: OPEN_STATUSES } }),
    findAlertContext(phoneE164, null, now),
  ]);
  const donor = user ? await DonorProfile.exists({ userId: user._id }) : null;
  return {
    role: institution ? "institution" : donor ? "donor" : openRequest ? "requester" : "unknown",
    hasRecentAlert: Boolean(alert),
    hasOpenRequest: Boolean(openRequest),
  };
}

/** Request details stated in a message, kept only if they pass the same validation as typed answers. */
export function validatedRequestEntities(entities: Interpretation["entities"], now: Date): Partial<Omit<RequestDraft, "flowId">> {
  const known: Partial<Omit<RequestDraft, "flowId">> = {};
  const group = entities.bloodGroup ? parseBloodGroup(entities.bloodGroup) : null;
  if (group) known.bloodGroup = group;
  const component = entities.component ? parseComponent(entities.component) : null;
  if (component) known.component = component;
  if (entities.units && Number.isInteger(entities.units) && entities.units >= 1 && entities.units <= 20) known.unitsRequested = entities.units;
  const city = entities.city ? hospitalStepSchema.shape.city.safeParse(entities.city) : null;
  if (city?.success) known.city = city.data;
  const locality = entities.locality ? hospitalStepSchema.shape.locality.safeParse(entities.locality) : null;
  if (locality?.success && known.city) known.locality = locality.data;
  const hospital = entities.hospitalName ? hospitalStepSchema.shape.hospitalName.safeParse(entities.hospitalName) : null;
  if (hospital?.success) known.hospitalName = hospital.data;
  const when = entities.requiredBy ? parseRequiredBy(entities.requiredBy, now) : null;
  if (when && !requiredByInRange(when.toISOString(), now)) known.requiredBy = when.toISOString();
  return known;
}

/** Acts on a proposed intent. Only read-only actions and conversation starts happen directly. */
async function actOnInterpretation(msg: InboundMessage, interpretation: Interpretation, source: "ai" | "keywords", now: Date): Promise<Route | null> {
  const say = (texts: string[]) => queueBotReplies(msg.fromE164, msg.providerMessageId, texts);
  const route: Route = source;
  const requestId = interpretation.entities.requestId ? findRequestId(interpretation.entities.requestId) : null;
  const confident = interpretation.confidence >= 0.5;
  if (!confident && interpretation.intent !== "create_request") return null;

  switch (interpretation.intent) {
    case "create_request": {
      if (!confident && !interpretation.entities.bloodGroup && !interpretation.entities.component) return null;
      const known = validatedRequestEntities(interpretation.entities, now);
      const noted = Object.keys(known).length
        ? "Got it. I've noted the details from your message; you'll check all of them before anything is submitted."
        : undefined;
      await startRequestConversation(msg, known, now, noted);
      return route;
    }
    case "track_request":
      await trackRequests(msg, requestId, now);
      return route;
    case "cancel_request":
      // Starts the cancellation questions; nothing is cancelled without the person's own YES.
      await startCancel(msg, requestId, now);
      return route;
    case "more_info":
      return (await handleAlertReply(msg, "more_info", requestId, now)) ? route : null;
    case "register_donor":
      await handleBotMessage(withText(msg, "REGISTER"), now);
      return route;
    case "view_profile":
      await handleBotMessage(withText(msg, "PROFILE"), now);
      return route;
    case "donor_status":
      await handleBotMessage(withText(msg, "STATUS"), now);
      return route;
    case "update_profile":
      await handleBotMessage(withText(msg, "UPDATE"), now);
      return route;
    case "pause_alerts":
    case "resume_alerts":
    case "stop_messages":
    case "donor_interested":
    case "donor_unavailable": {
      // Consent changes and responses are never made from an interpretation: the person confirms with the exact command.
      const confirm = {
        pause_alerts: "Do you want to pause emergency alerts? Reply PAUSE to confirm.",
        resume_alerts: "Do you want emergency alerts back on? Reply RESUME to confirm.",
        stop_messages: "Do you want to stop all messages from MarutiX? Reply STOP to confirm.",
        donor_interested: "Thank you! To confirm you can help with the latest alert, reply 1.",
        donor_unavailable: "No problem. To confirm you can't help with the latest alert, reply 2.",
      }[interpretation.intent];
      await recordAudit({ action: "ai.action_proposed", outcome: "success", requestId: randomUUID(), resourceType: "whatsapp_message", resourceId: `${source}:${interpretation.intent}` });
      await say([confirm]);
      return route;
    }
    case "help":
      await handleBotMessage(withText(msg, "HELP"), now);
      return route;
    case "greeting":
      // The menu (or the donor's command list) answers greetings; see route().
      return null;
    case "other": {
      if (source !== "ai") return null;
      const suggestion = safeSuggestedReply(interpretation);
      if (!suggestion) return null;
      await say([`${suggestion}\nReply REQUEST if you need blood, REGISTER to become a donor, or HELP for all options.`]);
      return route;
    }
  }
}

/** A menu option, chosen by number, word or Hindi equivalent. */
async function handleMenuChoice(choice: MenuChoice, menu: ConversationRecord, msg: InboundMessage, now: Date): Promise<Route> {
  switch (choice) {
    case "request":
      await startRequestConversation(msg, {}, now);
      return "request";
    case "donor":
      // Same as REGISTER: starts registration, or shows the profile of someone already registered.
      await handleBotMessage(withText(msg, "REGISTER"), now);
      return "donor";
    case "track":
      await closeMainMenu(menu, "completed", now);
      await trackRequests(msg, null, now);
      return "track";
    case "help":
      await closeMainMenu(menu, "completed", now);
      await queueBotReplies(msg.fromE164, msg.providerMessageId, [HELP_TEXT]);
      return "menu";
    case "decline":
      await closeMainMenu(menu, "cancelled", now);
      await queueBotReplies(msg.fromE164, msg.providerMessageId, [MENU_DECLINED_TEXT]);
      return "menu";
  }
}

/** Ends the menu if it's still the open conversation (a read-only command answered it). */
async function leaveMenu(phoneLookup: string, now: Date) {
  const current = await loadConversation(phoneLookup);
  if (current && isMenuConversation(current)) await closeMainMenu(current, "completed", now);
}

async function route(msg: InboundMessage, now: Date): Promise<Route> {
  await connectToDatabase();
  const keyword = keywordOf(msg);
  const lookup = phoneLookupToken(msg.fromE164);

  // 0. START resumes messages for anyone (the STOP confirmation tells everyone to reply START).
  //    It never starts donor registration: a patient's family must not be pushed into it.
  if (START_WORDS.has(keyword)) {
    const resubscribed = await liftOptOut(msg.fromE164, "whatsapp_join");
    if (await replyToDonorStart(msg, resubscribed)) return "donor";
    const existing = await loadConversation(lookup);
    // A brand-new number's first "START" gets the full welcome (and image), like any first message.
    const firstContact = currentReplyContext()?.attachWelcomeImage === true;
    await showMainMenu(msg, now, { welcome: firstContact, lead: resubscribed ? RESUBSCRIBED_TEXT : undefined, userId: existing?.userId ?? undefined });
    return "menu";
  }

  // After STOP the bot stays silent until START, or REGISTER/JOIN (which also lift the opt-out).
  if (!REGISTER_WORDS.has(keyword) && (await isOptedOut(lookup))) {
    logger.info("whatsapp.inbound_ignored", { reason: "opted_out" });
    return "ignored";
  }

  let conversation = await loadConversation(lookup);
  if (conversation?.status === "active" && conversation.flow === "donor_onboarding" && conversation.state === "await_start") {
    // Saved before the menu existed ("Would you like to register? YES/NO"): it is the menu now.
    await beginConversation({ phoneLookup: lookup, snapshot: { flow: "main_menu", state: "choose", history: [], data: { invalid: 0 } }, userId: conversation.userId ?? undefined, now });
    conversation = await loadConversation(lookup);
  }
  const menu = isMenuConversation(conversation) ? conversation : null;

  // MENU from anywhere; BACK while the menu is open (there's nothing further back) shows it again.
  if (MENU_WORDS.has(keyword) || (menu && (keyword === "BACK" || keyword === "GO BACK"))) {
    const setAside = conversation?.status === "active" && !menu;
    await showMainMenu(msg, now, { lead: setAside ? "Your earlier conversation was set aside." : undefined, userId: conversation?.userId ?? undefined });
    return "menu";
  }
  if (
    BACK_WORDS.has(keyword) &&
    conversation?.status === "active" &&
    (conversation.flow === "emergency_request" || conversation.flow === "donor_onboarding") &&
    conversation.history.length === 0
  ) {
    // BACK at the first question goes back to where the person chose this.
    const lead = conversation.flow === "emergency_request" ? "OK, the request was stopped. Nothing was submitted." : "OK, registration stopped. Nothing was saved.";
    await showMainMenu(msg, now, { lead, userId: conversation.userId ?? undefined });
    return "menu";
  }

  if (menu && msg.input.type === "text") {
    const choice = parseMenuChoice(msg.input.text);
    if (choice) {
      // A numbered answer to an emergency alert the donor just got outranks the menu.
      const alertReply = parseAlertReply(msg.input.text);
      if (alertReply && /^[1-4]$/.test(msg.input.text.trim()) && (await handleAlertReply(msg, alertReply, null, now))) return "alert_reply";
      return handleMenuChoice(choice, menu, msg, now);
    }
  }

  // 1. Active flows.
  if (conversation?.status === "active" && !menu) {
    if (REQUEST_WORDS.has(keyword) && conversation.flow !== "emergency_request") {
      await startRequestConversation(msg, {}, now, "Starting an emergency blood request. (Your earlier conversation was set aside; you can restart it later.)");
      return "request";
    }
    if (conversation.flow === "emergency_request") {
      await continueRequestConversation(conversation, msg, now);
      return "flow";
    }
    if (conversation.flow === "request_cancel") {
      await continueCancel(conversation, msg, now);
      return "flow";
    }
    if (conversation.flow === "donor_response") {
      // A new alert reply (1-4) outranks the open YES/NO question.
      const alertReply = msg.input.type === "text" ? parseAlertReply(msg.input.text) : null;
      if (!alertReply || alertReply === "interested") {
        await continueDonorResponse(conversation, msg, now);
        return "flow";
      }
      await saveConversation(conversation, { status: "cancelled", now });
    } else if (isDonorFlow(conversation.flow)) {
      await handleBotMessage(msg, now);
      return "flow";
    }
  }

  // 2. Verified institutions.
  if (await handleInstitutionCommand(msg, keyword, now)) return "institution";

  // 3. Patients and families.
  if (REQUEST_WORDS.has(keyword)) {
    await startRequestConversation(msg, {}, now);
    return "request";
  }
  if (firstWord(keyword) === "TRACK") {
    if (menu) await leaveMenu(lookup, now);
    await trackRequests(msg, findRequestId(keyword), now);
    return "track";
  }
  if (firstWord(keyword) === "CANCEL") {
    if (menu) await leaveMenu(lookup, now);
    await startCancel(msg, findRequestId(keyword), now);
    return "cancel";
  }

  // 4. Replies to an emergency alert.
  if (msg.input.type === "text") {
    const alertReply = parseAlertReply(msg.input.text);
    if (alertReply && (await handleAlertReply(msg, alertReply, findRequestId(msg.input.text), now))) return "alert_reply";
  }

  // 4a. A bare 1–4 as a number's very first message (from the welcome image, a poster or a
  //     forwarded message) is a menu choice: act on it instead of showing the menu first.
  if (msg.input.type === "text" && /^[1-4]$/.test(msg.input.text.trim()) && currentReplyContext()?.attachWelcomeImage && conversation?.status !== "active") {
    const choice = parseMenuChoice(msg.input.text);
    if (choice) {
      await beginConversation({ phoneLookup: lookup, snapshot: { flow: "main_menu", state: "choose", history: [], data: { invalid: 0 } }, now });
      const opened = await loadConversation(lookup);
      if (opened) return handleMenuChoice(choice, opened, msg, now);
    }
  }

  // 5. Donor commands, and location shares, go to the donor bot.
  if (menu && msg.input.type !== "text") {
    await menuNotUnderstood(menu, msg, now, "Thanks. First, please choose an option: reply 1, 2, 3 or 4.");
    return "menu";
  }
  if (DONOR_WORDS.has(keyword) || msg.input.type !== "text") {
    if (menu) await leaveMenu(lookup, now);
    await handleBotMessage(msg, now);
    return "donor";
  }

  // 6. Free text.
  const { interpretation, source } = await interpretMessage(msg.input.text, await senderContext(msg.fromE164, now), lookup, now);
  const greeting = interpretation.intent === "greeting";
  if (menu && greeting) {
    await showMainMenu(msg, now, { userId: menu.userId ?? undefined });
    return "menu";
  }
  const handled = await actOnInterpretation(msg, interpretation, source, now);
  if (handled) {
    if (menu) await leaveMenu(lookup, now);
    return handled;
  }
  if (menu) {
    await menuNotUnderstood(menu, msg, now);
    return "menu";
  }
  await handleBotMessage(msg, now, { greeting });
  return "donor";
}

/**
 * Routes one inbound message, retrying once if another message for the same
 * number raced it. `firstContact` (a number's first-ever message, see
 * inbound.ts) attaches the welcome image to the first reply.
 */
export async function processConversation(msg: InboundMessage, now = new Date(), options: { firstContact?: boolean } = {}): Promise<Route> {
  return runWithReplyContext({ inboundMessageId: msg.providerMessageId, attachWelcomeImage: Boolean(options.firstContact) }, async () => {
    try {
      return await route(msg, now);
    } catch (error) {
      if (!(error instanceof ConversationConflictError)) throw error;
      logger.warn("bot.conversation_conflict_retry");
      return route(msg, now);
    }
  });
}
