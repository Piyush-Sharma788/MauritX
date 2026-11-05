import "server-only";
import { randomUUID } from "node:crypto";
import type { Types } from "mongoose";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { BLOOD_GROUP_LABELS, donorRegistrationSchema } from "@/features/donors/schemas";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { logger } from "@/lib/logger";
import { phoneLookupToken } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import {
  advance,
  promptFor,
  startSnapshot,
  startUpdateSnapshot,
  type BotInput,
  type CompletedOnboarding,
  type OnboardingData,
} from "@/server/conversations/onboarding-machine";
import { showMainMenu } from "@/server/conversations/main-menu";
import { beginConversation, isDonorFlow, loadConversation, saveConversation, toSnapshot } from "@/server/conversations/store";
import { changeNotifications, getDonorOverview, registerDonor, setAvailability, updateDonorProfile } from "@/server/donors/service";
import { isOptedOut } from "@/server/messaging/eligibility";
import { liftOptOut } from "@/server/messaging/opt-out";
import { queueBotReplies } from "@/server/messaging/queue";
import { currentReplyContext } from "@/server/messaging/reply-context";
import { HELP_TEXT } from "@/server/messaging/templates";
import { OPEN_STATUSES } from "@/features/requests/schemas";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { NotificationEvent } from "@/server/models/notification-event";
import { User } from "@/server/models/user";
import { findOrCreateVerifiedUser } from "@/server/services/users";

/**
 * WhatsApp donor bot: the only donor registration channel. It turns inbound
 * messages into state-machine steps, persists progress and queues replies.
 * The donor's number comes from the inbound message, never from typed input.
 * Donor data changes go through the donor service; sending goes through the
 * provider-neutral outbox.
 */

export interface InboundMessage {
  providerMessageId: string;
  /** Normalised E.164 number of the WhatsApp sender. */
  fromE164: string;
  input: BotInput;
}

export type BotAction = "onboarding" | "registered" | "updating" | "updated" | "command" | "menu" | "welcome" | "ignored";

/** REGISTER is the primary keyword; the others are common alternatives. They also re-open a stopped number. */
export const REGISTER_WORDS = new Set(["REGISTER", "JOIN", "SIGN UP", "SIGNUP", "DONATE", "DONOR"]);
/** "Resume messages" after STOP (the opt-out confirmation tells everyone to reply START). Never starts registration. */
export const START_WORDS = new Set(["START", "UNSTOP", "RESUBSCRIBE"]);

export const RESUBSCRIBED_TEXT = "You're subscribed to MarutiX messages again. ✅";

/**
 * START for a registered donor: confirm and show their profile. Alerts stay off if STOP
 * turned them off: withdrawn consent is only restored by the donor's own explicit choice.
 * Returns false for anyone who isn't a registered donor (the caller shows the menu).
 */
export async function replyToDonorStart(msg: InboundMessage, resubscribed: boolean): Promise<boolean> {
  const user = await User.findOne({ phoneLookup: phoneLookupToken(msg.fromE164) }, { _id: 1 }).lean();
  if (!user || !(await DonorProfile.exists({ userId: user._id }))) return false;
  const status = (await getDonorOverview(user._id)).profile?.notifications.status;
  const alertsOff = status !== "active" && status !== "paused";
  await reply(
    msg,
    [
      [
        resubscribed ? RESUBSCRIBED_TEXT : "You're already subscribed to MarutiX messages. ✅",
        alertsOff ? "Emergency alerts are still off. To turn them back on, reply UPDATE and choose 7." : null,
      ].filter(Boolean).join("\n"),
      await statusText(user._id),
    ],
    user._id,
  );
  return true;
}
const keywordOf = (input: BotInput) => (input.type === "text" ? input.text.trim().toUpperCase().replace(/\s+/g, " ") : "");
const DAY_MS = 24 * 60 * 60 * 1000;

const WELCOME_BACK = "Welcome back! Let's continue where you left off.";
const NOT_REGISTERED = "You're not registered as a donor yet. Reply REGISTER to register. It takes about 2 minutes.\nNeed blood for a patient? Reply REQUEST.";

function registrationIntro(phoneE164: string) {
  // On a number's first-ever message this is the welcome (and the image caption); after the
  // menu, which already said welcome, it just continues.
  const opening = currentReplyContext()?.attachWelcomeImage
    ? "Welcome to MarutiX 🩸 Let's register you as a voluntary blood donor."
    : "Let's register you as a voluntary blood donor 🩸";
  return `${opening} It takes about 2 minutes.\nWe'll use this WhatsApp number (${maskPhone(phoneE164)}), so you don't need to type it.`;
}

/** No reply on purpose: logged with the reason (never the number). */
const ignored = (reason: string): BotAction => {
  logger.info("whatsapp.inbound_ignored", { reason });
  return "ignored";
};

function completionText(data: CompletedOnboarding): string {
  return [
    `You're registered, ${data.name.split(" ")[0]}! Thank you for volunteering as a MarutiX blood donor. 🩸`,
    data.notificationConsent
      ? "We'll message you only about emergency blood requests near you. Reply PAUSE to pause alerts, or STOP to stop all messages."
      : "You chose not to receive alerts. You can turn them on any time: reply UPDATE.",
    "Reply PROFILE to see your details or UPDATE to change them. To manage your profile on the website, sign in at MarutiX with this number.",
    "Registering isn't a medical eligibility check. A licensed blood centre always makes that decision.",
  ].join("\n");
}

async function reply(msg: InboundMessage, replies: string[], userId?: Types.ObjectId, templateName?: "bot_reply" | "bot_menu") {
  if (replies.length) await queueBotReplies(msg.fromE164, msg.providerMessageId, replies, userId, templateName);
}

/** At most one unprompted menu reply per number per day, so casual messages don't trigger a bot loop. */
async function menuSentRecently(phoneLookup: string, now: Date) {
  return (await NotificationEvent.exists({ recipientLookup: phoneLookup, templateName: "bot_menu", createdAt: { $gte: new Date(now.getTime() - DAY_MS) } })) !== null;
}

/** STATUS: availability and alert preference at a glance. */
async function availabilityText(userId: Types.ObjectId): Promise<string> {
  const p = (await getDonorOverview(userId)).profile;
  if (!p) return NOT_REGISTERED;
  const alerts = { active: "On", paused: "Paused", opted_out: "Off", not_enabled: "Off" }[p.notifications.status];
  return [
    `Available to donate: ${p.availableForRequests ? "Yes" : "Not right now"}`,
    `Emergency alerts: ${alerts}`,
    p.notifications.status === "active"
      ? "Reply PAUSE to pause alerts."
      : p.notifications.status === "paused"
        ? "Reply RESUME to turn alerts back on."
        : "Reply UPDATE and choose 7 to turn alerts on.",
    "Reply PROFILE for all your details.",
  ].join("\n");
}

/** PROFILE: the donor's full details. */
async function statusText(userId: Types.ObjectId): Promise<string> {
  const overview = await getDonorOverview(userId);
  const p = overview.profile;
  if (!p) return NOT_REGISTERED;
  const alerts = { active: "On", paused: "Paused", opted_out: "Off", not_enabled: "Off" }[p.notifications.status];
  return [
    `MarutiX donor: ${p.name}`,
    `WhatsApp number: ${p.maskedPhone}`,
    `Blood group: ${BLOOD_GROUP_LABELS[p.bloodGroup]}`,
    `Area: ${p.locality}, ${p.city}`,
    `Location: ${p.location ? "Approximate location shared" : "Not shared"}`,
    `Last donation: ${p.lastDonationDate ?? "Not provided"}`,
    `Available to donate: ${p.availableForRequests ? "Yes" : "Not right now"}`,
    `Emergency alerts: ${alerts}`,
    "Reply UPDATE to change your details.",
  ].join("\n");
}

async function completeRegistration(msg: InboundMessage, data: CompletedOnboarding): Promise<{ replies: string[]; userId?: Types.ObjectId }> {
  const phoneLookup = phoneLookupToken(msg.fromE164);
  let user;
  try {
    // The WhatsApp number is the identity: one account, and one profile, per normalised number.
    ({ user } = await findOrCreateVerifiedUser(msg.fromE164, phoneLookup));
  } catch (error) {
    if (error instanceof AppError && error.code === "ACCOUNT_UNAVAILABLE") {
      return { replies: ["We can't register this number right now. Please contact MarutiX support."] };
    }
    throw error;
  }

  const input = donorRegistrationSchema.parse({ ...data, privacyNoticeVersion: PRIVACY_NOTICE_VERSION });
  try {
    await registerDonor(user._id, input, { requestId: randomUUID() });
  } catch (error) {
    if (error instanceof AppError && error.code === "DONOR_ALREADY_REGISTERED") {
      return { replies: ["You're already registered as a MarutiX donor, so nothing was changed. Reply PROFILE to see your details."], userId: user._id };
    }
    throw error;
  }
  return { replies: [completionText(data)], userId: user._id };
}

/** Applies an UPDATE through the donor service and reports the result. */
async function applyUpdate(userId: Types.ObjectId, changes: OnboardingData): Promise<string[]> {
  const requestId = randomUUID();
  const patch = {
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.bloodGroup !== undefined ? { bloodGroup: changes.bloodGroup } : {}),
    ...(changes.city !== undefined ? { city: changes.city } : {}),
    ...(changes.locality !== undefined ? { locality: changes.locality } : {}),
    ...(changes.location !== undefined ? { location: changes.location } : {}),
    ...(changes.lastDonationDate !== undefined ? { lastDonationDate: changes.lastDonationDate } : {}),
  };
  if (Object.keys(patch).length) await updateDonorProfile(userId, patch, requestId);
  if (changes.availableForRequests !== undefined) await setAvailability(userId, changes.availableForRequests, requestId);

  if (changes.notificationConsent !== undefined) {
    const status = (await getDonorOverview(userId)).profile?.notifications.status;
    if (changes.notificationConsent && status !== "active") {
      await changeNotifications(userId, status === "paused" ? "resume" : "enable", "whatsapp", requestId);
    } else if (!changes.notificationConsent && status === "active") {
      await changeNotifications(userId, "pause", "whatsapp", requestId);
    }
  }
  return ["Done. Your details are updated. ✅", await statusText(userId)];
}

/**
 * Handles one inbound message from a number that isn't opted out (or is sending REGISTER/START).
 * `greeting`: the text was a greeting ("hi", "namaste"), which always gets the menu.
 */
export async function handleBotMessage(msg: InboundMessage, now = new Date(), options: { greeting?: boolean } = {}): Promise<BotAction> {
  await connectToDatabase();
  const phoneLookup = phoneLookupToken(msg.fromE164);
  const keyword = keywordOf(msg.input);
  const conversation = await loadConversation(phoneLookup);

  // 1. A donor conversation is in progress: the state machine handles it.
  if (conversation?.status === "active" && isDonorFlow(conversation.flow)) {
    const snapshot = toSnapshot(conversation);
    let input = msg.input;
    if (snapshot.flow === "donor_onboarding" && REGISTER_WORDS.has(keyword)) {
      // At the opening "Would you like to register? YES/NO", REGISTER is the answer yes,
      // not a reason to ask the same question again.
      if (snapshot.state === "await_start") {
        input = { type: "text", text: "YES" };
      } else {
        await reply(msg, ["You're already registering. Let's continue.", promptFor(snapshot)]);
        await saveConversation(conversation, { snapshot, status: "active", now });
        return "onboarding";
      }
    }
    // A long gap: greet before re-asking, so the donor knows where they are.
    const resumed = conversation.lastInboundAt && now.getTime() - conversation.lastInboundAt.getTime() > 60 * 60 * 1000;
    const outcome = advance(snapshot, input);
    const updating = snapshot.flow === "donor_update";

    if (outcome.type === "continue") {
      await saveConversation(conversation, { snapshot: outcome.snapshot, status: "active", now });
      const repliedWithError = outcome.snapshot === snapshot;
      await reply(msg, resumed && repliedWithError ? [WELCOME_BACK, promptFor(snapshot)] : outcome.replies);
      return updating ? "updating" : "onboarding";
    }
    if (outcome.type === "cancelled") {
      await saveConversation(conversation, { status: "cancelled", now });
      await reply(msg, outcome.replies);
      return updating ? "updating" : "onboarding";
    }
    if (outcome.type === "updated") {
      const user = await User.findOne({ phoneLookup }, { _id: 1 }).lean();
      const hasProfile = user ? await DonorProfile.exists({ userId: user._id }) : null;
      await saveConversation(conversation, { status: "completed", now });
      if (!user || !hasProfile) {
        await reply(msg, [NOT_REGISTERED]);
        return "updated";
      }
      await reply(msg, await applyUpdate(user._id, outcome.changes), user._id);
      return "updated";
    }
    const result = await completeRegistration(msg, outcome.data);
    await saveConversation(conversation, { status: "completed", userId: result.userId, now });
    await reply(msg, result.replies, result.userId);
    return "registered";
  }

  // 2. No active conversation.
  const user = await User.findOne({ phoneLookup }, { _id: 1 }).lean();
  const profile = user ? await DonorProfile.exists({ userId: user._id }) : null;

  if (REGISTER_WORDS.has(keyword)) {
    // REGISTER/START is an explicit request to talk again, even after STOP.
    await liftOptOut(msg.fromE164, "whatsapp_join");
    if (profile && user) {
      await reply(msg, ["You're already registered as a MarutiX donor. 🩸", await statusText(user._id)], user._id);
      return "command";
    }
    const snapshot = startSnapshot(true);
    await beginConversation({ phoneLookup, snapshot, userId: user?._id, now });
    await reply(msg, [registrationIntro(msg.fromE164), promptFor(snapshot)]);
    return "welcome";
  }

  // Everyone else who opted out hears nothing until they send REGISTER or START.
  if (await isOptedOut(phoneLookup)) return ignored("opted_out");

  if (keyword === "HELP") {
    await reply(msg, [HELP_TEXT], user?._id);
    return "command";
  }
  if (keyword === "STATUS") {
    await reply(msg, [user ? await availabilityText(user._id) : NOT_REGISTERED], user?._id);
    return "command";
  }
  if (keyword === "PROFILE" || keyword === "MY PROFILE") {
    await reply(msg, [user ? await statusText(user._id) : NOT_REGISTERED], user?._id);
    return "command";
  }
  if (keyword === "UPDATE" || keyword === "EDIT") {
    if (!user || !profile) {
      await reply(msg, [NOT_REGISTERED]);
      return "command";
    }
    const snapshot = startUpdateSnapshot();
    await beginConversation({ phoneLookup, snapshot, userId: user._id, now });
    await reply(msg, [promptFor(snapshot)], user._id);
    return "updating";
  }
  if (keyword === "PAUSE" || keyword === "RESUME") {
    if (!user || !profile) {
      await reply(msg, [NOT_REGISTERED]);
      return "command";
    }
    try {
      await changeNotifications(user._id, keyword === "PAUSE" ? "pause" : "resume", "whatsapp", randomUUID());
      await reply(
        msg,
        [keyword === "PAUSE" ? "Emergency alerts are paused. Reply RESUME whenever you'd like them back." : "Emergency alerts are back on. Thank you! 🩸"],
        user._id,
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await reply(msg, [error.message, "Reply UPDATE and choose 7 to turn alerts on."], user._id);
    }
    return "command";
  }

  if (profile && user) {
    if (await menuSentRecently(phoneLookup, now)) return ignored("menu_sent_recently");
    await reply(msg, [HELP_TEXT], user._id, "bot_menu");
    return "menu";
  }

  // Someone with an open blood request (e.g. replying to their confirmation) shouldn't get the donor pitch.
  if (await EmergencyRequest.exists({ contactPhoneLookup: phoneLookup, status: { $in: OPEN_STATUSES } })) {
    if (await menuSentRecently(phoneLookup, now)) return ignored("menu_sent_recently");
    await reply(
      msg,
      [
        "MarutiX: we've received your blood request. Reply TRACK to see its status. Our team verifies every request with the hospital.\nKeep working with the hospital's blood bank, and call 112 if life is at risk.\nReply REGISTER if you'd like to become a donor, or STOP to stop messages.",
      ],
      undefined,
      "bot_menu",
    );
    return "menu";
  }

  // Unknown number: the welcome menu (patients and donors alike). Unprompted, it's sent at most
  // once a day, and not within a day of them declining; a greeting always gets it.
  if (!options.greeting) {
    if (conversation?.status === "cancelled" && conversation.cancelledAt && now.getTime() - conversation.cancelledAt.getTime() < DAY_MS) {
      return ignored("declined_recently");
    }
    if (await menuSentRecently(phoneLookup, now)) return ignored("menu_sent_recently");
  }
  await showMainMenu(msg, now, { welcome: true, userId: user?._id });
  return "welcome";
}
