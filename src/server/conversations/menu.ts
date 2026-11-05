/**
 * The first-contact menu: what a new number sees, and what MENU or BACK (at
 * a flow's first question) brings back. Pure: texts and the choice parser.
 * The engine (engine.ts) keeps the menu as the active conversation
 * (flow "main_menu") and acts on the choice.
 */

export type MenuChoice = "request" | "donor" | "track" | "help" | "decline";

const OPTIONS = [
  "1. I need blood for a patient",
  "2. I want to become a donor",
  "3. Track my request",
  "4. Help",
].join("\n");

/** The welcome on a number's first message (also the welcome image's caption). */
export const WELCOME_MENU_TEXT = [
  "Welcome to MarutiX 🩸 We connect patients' families with voluntary blood donors and verified hospitals.",
  "",
  "How can we help? Reply with a number:",
  OPTIONS,
  "",
  "You can also type what you need in your own words, in English or Hindi.",
  "In a life-threatening emergency, call 112. Reply STOP anytime to stop messages.",
].join("\n");

/** MENU, BACK at a flow's first question, or a greeting while the menu is open. */
export const MENU_TEXT = ["MarutiX menu. Reply with a number:", OPTIONS, "", "Or tell me what you need in your own words. In an emergency, call 112."].join("\n");

export const MENU_HINT = "Sorry, I didn't get that. Please reply 1, 2, 3 or 4, or tell me in a few words what you need.";

/** After three replies the menu couldn't understand, it closes instead of repeating itself. */
export const MENU_MAX_INVALID = 3;
export const MENU_GIVE_UP_TEXT = "No problem. Reply MENU whenever you'd like to see the options again. In a medical emergency, call 112.";
export const MENU_DECLINED_TEXT = "No problem. Reply MENU any time if you need us. In a medical emergency, call 112.";

/** Words that open the menu from anywhere (except after STOP). */
export const MENU_WORDS = new Set(["MENU", "MAIN MENU", "OPTIONS", "HOME"]);

const normalise = (text: string) =>
  text
    .trim()
    .toUpperCase()
    .replace(/[.!,)\]]+$/g, "")
    .replace(/^[(\[]/, "")
    .replace(/\s+/g, " ");

const CHOICES: [MenuChoice, string[]][] = [
  ["request", ["1", "ONE", "EK", "1 REQUEST", "REQUEST", "NEED BLOOD", "BLOOD", "EMERGENCY", "NEW REQUEST", "BLOOD REQUEST", "PATIENT"]],
  // YES keeps the old opening question ("Would you like to register as a donor? YES/NO") working.
  ["donor", ["2", "TWO", "DO", "2 DONOR", "REGISTER", "JOIN", "SIGN UP", "SIGNUP", "DONATE", "DONOR", "BECOME A DONOR", "YES", "Y", "HAAN", "HAN", "HA", "HA JI", "HAAN JI"]],
  ["track", ["3", "THREE", "TEEN", "TRACK", "TRACK REQUEST", "TRACK MY REQUEST", "MY REQUEST"]],
  ["help", ["4", "FOUR", "CHAR", "CHAAR", "HELP", "?", "MADAD"]],
  ["decline", ["NO", "N", "NAH", "NOPE", "NAHI", "NAHIN", "NHI", "NO THANKS", "NOT NOW"]],
];
const CHOICE_BY_WORD = new Map(CHOICES.flatMap(([choice, words]) => words.map((w) => [w, choice] as const)));

/**
 * The menu option a reply picks, or null. Only exact short answers count
 * (numbers, the command words, yes/no in English and Hindi); anything longer
 * goes through intent detection, which also extracts details like the blood group.
 */
export function parseMenuChoice(text: string): MenuChoice | null {
  return CHOICE_BY_WORD.get(normalise(text)) ?? null;
}
