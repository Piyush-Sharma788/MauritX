import "server-only";
import type { Types } from "mongoose";
import { phoneLookupToken } from "@/lib/security/crypto";
import type { InboundMessage } from "@/server/conversations/bot";
import { MENU_GIVE_UP_TEXT, MENU_HINT, MENU_MAX_INVALID, MENU_TEXT, WELCOME_MENU_TEXT } from "@/server/conversations/menu";
import { beginConversation, saveConversation, toFlowSnapshot, type ConversationRecord } from "@/server/conversations/store";
import { queueBotReplies } from "@/server/messaging/queue";

/** Saved with the menu: how many replies in a row it couldn't understand. */
interface MenuData {
  invalid: number;
}

export const isMenuConversation = (c: ConversationRecord | null): c is ConversationRecord =>
  c?.status === "active" && (c.flow === "main_menu" || (c.flow === "donor_onboarding" && c.state === "await_start"));

/**
 * Opens the menu as the active conversation and shows it. `welcome` is the
 * unprompted first-contact version (counted towards the one-menu-a-day rule);
 * otherwise the person asked for it (MENU, BACK, a greeting).
 */
export async function showMainMenu(msg: InboundMessage, now: Date, options: { welcome?: boolean; lead?: string; userId?: Types.ObjectId } = {}) {
  await beginConversation({
    phoneLookup: phoneLookupToken(msg.fromE164),
    snapshot: { flow: "main_menu", state: "choose", history: [], data: { invalid: 0 } satisfies MenuData },
    userId: options.userId,
    now,
  });
  const text = options.welcome ? WELCOME_MENU_TEXT : MENU_TEXT;
  await queueBotReplies(msg.fromE164, msg.providerMessageId, options.lead ? [options.lead, text] : [text], options.userId, options.welcome ? "bot_menu" : "bot_reply");
}

/** A reply the menu couldn't use: the menu again with a hint, closing quietly after a few tries. */
export async function menuNotUnderstood(conversation: ConversationRecord, msg: InboundMessage, now: Date, hint = MENU_HINT) {
  const data = conversation.flow === "main_menu" ? toFlowSnapshot<string, Partial<MenuData>>(conversation).data : {};
  const invalid = (data.invalid ?? 0) + 1;
  if (invalid >= MENU_MAX_INVALID) {
    await saveConversation(conversation, { status: "cancelled", now });
    await queueBotReplies(msg.fromE164, msg.providerMessageId, [MENU_GIVE_UP_TEXT]);
    return;
  }
  await saveConversation(conversation, { snapshot: { flow: "main_menu", state: "choose", history: [], data: { invalid } satisfies MenuData }, status: "active", now });
  await queueBotReplies(msg.fromE164, msg.providerMessageId, [hint, MENU_TEXT]);
}

/** The menu has done its job (a read-only choice) or was declined. */
export async function closeMainMenu(conversation: ConversationRecord, status: "completed" | "cancelled", now: Date) {
  await saveConversation(conversation, { status, now });
}
