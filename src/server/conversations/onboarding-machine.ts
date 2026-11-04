import {
  BLOOD_GROUP_LABELS,
  citySchema,
  coarsenLocation,
  donorNameSchema,
  localitySchema,
  locationSchema,
  type BloodGroup,
} from "@/features/donors/schemas";
import { isSkip, parseAvailability, parseBloodGroup, parseDonationDate, parseYesNo } from "@/features/donors/parse";

/**
 * WhatsApp donor conversations as a pure state machine: each state declares
 * its prompt, how to parse an answer and where to go next. Two flows share the
 * same question definitions:
 * - donor_onboarding: full registration (REGISTER / JOIN);
 * - donor_update: change one detail of an existing profile (UPDATE).
 * No I/O here, so every path is unit-testable; persistence and sending live
 * in bot.ts.
 */

export const ONBOARDING_STATES = [
  "await_start",
  "name",
  "blood_group",
  "city",
  "locality",
  "location",
  "last_donation",
  "availability",
  "notification_consent",
  "confirm",
  "update_menu",
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];
export type ConversationFlow = "donor_onboarding" | "donor_update";

export interface OnboardingData {
  name?: string;
  bloodGroup?: BloodGroup;
  city?: string;
  locality?: string;
  location?: { latitude: number; longitude: number } | null;
  lastDonationDate?: string | null;
  availableForRequests?: boolean;
  notificationConsent?: boolean;
}

export type CompletedOnboarding = Required<OnboardingData>;

export type BotInput = { type: "text"; text: string } | { type: "location"; latitude: number; longitude: number };

export interface Snapshot {
  flow: ConversationFlow;
  state: OnboardingState;
  history: OnboardingState[];
  data: OnboardingData;
}

export type Outcome =
  | { type: "continue"; snapshot: Snapshot; replies: string[] }
  | { type: "complete"; data: CompletedOnboarding; replies: string[] }
  | { type: "updated"; changes: OnboardingData; replies: string[] }
  | { type: "cancelled"; replies: string[] };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

interface Step<T> {
  prompt(data: OnboardingData): string;
  parse(input: BotInput): Parsed<T>;
  save(data: OnboardingData, value: T): OnboardingData;
  next: OnboardingState | "complete" | ((value: T) => OnboardingState | "complete" | "cancel");
}

const TEXT_ONLY = "Please reply with text for this question.";
const fail = (error: string) => ({ ok: false as const, error });
const ok = <T,>(value: T) => ({ ok: true as const, value });

function textStep<T>(parseText: (text: string) => Parsed<T>): (input: BotInput) => Parsed<T> {
  return (input) => (input.type === "text" ? parseText(input.text) : fail(TEXT_ONLY));
}

function zodText<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }) {
  return textStep((text) => {
    const r = schema.safeParse(text);
    return r.success ? ok(r.data) : fail(r.error.issues[0]?.message ?? "Please try again.");
  });
}

const firstName = (d: OnboardingData) => d.name?.split(" ")[0] ?? "";

function summary(d: OnboardingData): string {
  return [
    "Please check your details:",
    `Name: ${d.name}`,
    `Blood group: ${d.bloodGroup ? BLOOD_GROUP_LABELS[d.bloodGroup] : "-"}`,
    `Area: ${d.locality}, ${d.city}`,
    `Location: ${d.location ? "Approximate location shared" : "Not shared"}`,
    `Last donation: ${d.lastDonationDate ?? "Not provided"}`,
    `Availability: ${d.availableForRequests ? "Available to donate" : "Not available right now"}`,
    `Emergency alerts: ${d.notificationConsent ? "Yes, send me alerts" : "No alerts"}`,
    "",
    "Reply YES to confirm, BACK to change your last answer, or RESTART to start over.",
    "Registering isn't a medical eligibility check. A licensed blood centre always makes that decision.",
  ].join("\n");
}

const STEPS: { [S in OnboardingState]: Step<never> } = {
  await_start: {
    prompt: () =>
      "Welcome to MarutiX 🩸\nWould you like to register as a voluntary blood donor? It takes about 2 minutes.\nReply YES or NO.\n\nNeed blood for a patient? Reply REQUEST instead.",
    parse: textStep((t) => {
      const v = parseYesNo(t);
      return v === null ? fail("Please reply YES or NO.") : ok(v);
    }),
    save: (d) => d,
    next: (v: boolean) => (v ? "name" : "cancel"),
  },
  name: {
    prompt: () =>
      "What's your name? You can use your full name or the name you prefer.\n(At any point, reply BACK to go back or CANCEL to stop.)",
    parse: zodText(donorNameSchema),
    save: (d, v: string) => ({ ...d, name: v }),
    next: "blood_group",
  },
  blood_group: {
    prompt: (d) => `${d.name ? `Thanks, ${firstName(d)}. ` : ""}What's your blood group?\nReply A+, A-, B+, B-, AB+, AB-, O+ or O-, or NOT SURE if you don't know.`,
    parse: textStep((t) => {
      const v = parseBloodGroup(t);
      return v ? ok(v) : fail("I didn't recognise that blood group. Reply A+, A-, B+, B-, AB+, AB-, O+, O- or NOT SURE.");
    }),
    save: (d, v: BloodGroup) => ({ ...d, bloodGroup: v }),
    next: "city",
  },
  city: {
    prompt: () => "Which city do you live in?",
    parse: zodText(citySchema),
    save: (d, v: string) => ({ ...d, city: v }),
    next: "locality",
  },
  locality: {
    prompt: (d) => (d.city ? `Which locality or area in ${d.city}?` : "Which locality or area?"),
    parse: zodText(localitySchema),
    save: (d, v: string) => ({ ...d, locality: v }),
    next: "location",
  },
  location: {
    prompt: () =>
      "Optional: share your location so we only alert you about requests nearby.\nTap 📎 → Location → Send your current location, or reply SKIP.\nWe keep it to about 1 km and never show it to anyone.",
    parse: (input) => {
      if (input.type === "text") {
        return isSkip(input.text) ? ok(null) : fail("Please share your location using 📎 → Location, or reply SKIP.");
      }
      const r = locationSchema.safeParse({ latitude: input.latitude, longitude: input.longitude });
      return r.success ? ok(coarsenLocation(r.data)) : fail("That location seems to be outside India. Share another location, or reply SKIP.");
    },
    save: (d, v: OnboardingData["location"]) => ({ ...d, location: v }),
    next: "last_donation",
  },
  last_donation: {
    prompt: () => "When did you last donate blood? Reply with a date like 15-08-2025, or SKIP if you never have or don't remember.",
    parse: textStep((t) => {
      if (isSkip(t)) return ok(null);
      const v = parseDonationDate(t);
      return v ? ok(v) : fail("Please send a date like 15-08-2025 (not in the future), or reply SKIP.");
    }),
    save: (d, v: string | null) => ({ ...d, lastDonationDate: v }),
    next: "availability",
  },
  availability: {
    prompt: () => "Are you available to donate if someone nearby needs blood?\n1. Yes, I'm available\n2. Not right now",
    parse: textStep((t) => {
      const v = parseAvailability(t);
      return v === null ? fail("Reply 1 if you're available, or 2 if not right now.") : ok(v);
    }),
    save: (d, v: boolean) => ({ ...d, availableForRequests: v }),
    next: "notification_consent",
  },
  notification_consent: {
    prompt: () =>
      "May MarutiX send you WhatsApp alerts about emergency blood requests near you?\nYou can reply PAUSE or STOP at any time.\nReply YES to allow alerts, or NO to register without alerts.",
    parse: textStep((t) => {
      const v = parseYesNo(t);
      return v === null ? fail("Please reply YES to allow alerts, or NO to register without them.") : ok(v);
    }),
    save: (d, v: boolean) => ({ ...d, notificationConsent: v }),
    next: "confirm",
  },
  confirm: {
    prompt: summary,
    parse: textStep((t) => {
      const v = parseYesNo(t);
      return v === true ? ok(true) : fail("Reply YES to confirm, BACK to change your last answer, or RESTART to start over.");
    }),
    save: (d) => d,
    next: "complete",
  },
  update_menu: {
    prompt: () =>
      "What would you like to update?\n1. Name\n2. Blood group\n3. City and locality\n4. Location\n5. Last donation date\n6. Availability\n7. Emergency alerts\nReply with a number, or CANCEL.",
    parse: textStep((t) => {
      const choice = UPDATE_CHOICES[t.trim()];
      return choice ? ok(choice) : fail("Please reply with a number from 1 to 7, or CANCEL.");
    }),
    save: (d) => d,
    next: (choice: OnboardingState) => choice,
  },
} as { [S in OnboardingState]: Step<never> };

const UPDATE_CHOICES: Record<string, OnboardingState> = {
  "1": "name",
  "2": "blood_group",
  "3": "city",
  "4": "location",
  "5": "last_donation",
  "6": "availability",
  "7": "notification_consent",
};

/** In the update flow each detail is a single question, except city, which continues to locality. */
const UPDATE_NEXT: Partial<Record<OnboardingState, OnboardingState | "updated">> = {
  name: "updated",
  blood_group: "updated",
  city: "locality",
  locality: "updated",
  location: "updated",
  last_donation: "updated",
  availability: "updated",
  notification_consent: "updated",
};

export function promptFor(snapshot: Snapshot): string {
  return STEPS[snapshot.state].prompt(snapshot.data);
}

/** A fresh registration. Skip the "would you like to register?" question when intent is already clear. */
export function startSnapshot(intentConfirmed: boolean): Snapshot {
  return { flow: "donor_onboarding", state: intentConfirmed ? "name" : "await_start", history: [], data: {} };
}

/** UPDATE: pick one detail to change. */
export function startUpdateSnapshot(): Snapshot {
  return { flow: "donor_update", state: "update_menu", history: [], data: {} };
}

const COMMANDS = {
  BACK: ["BACK", "PREVIOUS"],
  CANCEL: ["CANCEL", "QUIT", "EXIT"],
  RESTART: ["RESTART", "START OVER"],
  HELP: ["HELP", "?"],
};
const isCommand = (text: string, list: string[]) => list.includes(text.trim().toUpperCase().replace(/\s+/g, " "));

function isComplete(d: OnboardingData): d is CompletedOnboarding {
  return (
    !!d.name && !!d.bloodGroup && !!d.city && !!d.locality && d.location !== undefined && d.lastDonationDate !== undefined &&
    typeof d.availableForRequests === "boolean" && typeof d.notificationConsent === "boolean"
  );
}

/** Applies one inbound message to the conversation. */
export function advance(snapshot: Snapshot, input: BotInput): Outcome {
  return snapshot.flow === "donor_update" ? advanceUpdate(snapshot, input) : advanceOnboarding(snapshot, input);
}

const prompt = (s: Snapshot) => STEPS[s.state].prompt(s.data);

function advanceUpdate(snapshot: Snapshot, input: BotInput): Outcome {
  const menu = startUpdateSnapshot();
  if (input.type === "text") {
    if (isCommand(input.text, COMMANDS.CANCEL)) return { type: "cancelled", replies: ["No changes were made."] };
    if (isCommand(input.text, COMMANDS.RESTART) || isCommand(input.text, ["UPDATE"])) return { type: "continue", snapshot: menu, replies: [prompt(menu)] };
    if (isCommand(input.text, COMMANDS.HELP)) {
      return { type: "continue", snapshot, replies: ["You're updating your donor details. Reply BACK for the menu, CANCEL to stop, or STOP to stop all messages.", prompt(snapshot)] };
    }
    if (isCommand(input.text, COMMANDS.BACK)) {
      if (snapshot.state === "update_menu") return { type: "continue", snapshot, replies: ["This is the first question.", prompt(snapshot)] };
      return { type: "continue", snapshot: menu, replies: [prompt(menu)] };
    }
  }

  const step = STEPS[snapshot.state] as unknown as Step<unknown>;
  const parsed = step.parse(input);
  if (!parsed.ok) return { type: "continue", snapshot, replies: [parsed.error] };
  const data = step.save(snapshot.data, parsed.value);

  if (snapshot.state === "update_menu") {
    const next: Snapshot = { flow: "donor_update", state: parsed.value as OnboardingState, history: [], data };
    return { type: "continue", snapshot: next, replies: [prompt(next)] };
  }
  const next = UPDATE_NEXT[snapshot.state];
  if (next === "updated" || !next) return { type: "updated", changes: data, replies: [] };
  const advanced: Snapshot = { flow: "donor_update", state: next, history: [], data };
  return { type: "continue", snapshot: advanced, replies: [prompt(advanced)] };
}

function advanceOnboarding(snapshot: Snapshot, input: BotInput): Outcome {
  if (input.type === "text") {
    if (isCommand(input.text, COMMANDS.CANCEL)) {
      return { type: "cancelled", replies: ["Registration cancelled and your answers were deleted. Message REGISTER whenever you'd like to register."] };
    }
    if (isCommand(input.text, COMMANDS.RESTART)) {
      const fresh: Snapshot = { flow: "donor_onboarding", state: "name", history: [], data: {} };
      return { type: "continue", snapshot: fresh, replies: ["Let's start over.", prompt(fresh)] };
    }
    if (isCommand(input.text, COMMANDS.HELP)) {
      return {
        type: "continue",
        snapshot,
        replies: ["You're registering as a MarutiX donor. Reply BACK to go back, RESTART to start over, CANCEL to stop, or STOP to stop all messages.", prompt(snapshot)],
      };
    }
    if (isCommand(input.text, COMMANDS.BACK)) {
      const previous = snapshot.history.at(-1);
      if (!previous) return { type: "continue", snapshot, replies: ["This is the first question.", prompt(snapshot)] };
      const back: Snapshot = { ...snapshot, state: previous, history: snapshot.history.slice(0, -1) };
      return { type: "continue", snapshot: back, replies: [prompt(back)] };
    }
  }

  const step = STEPS[snapshot.state] as unknown as Step<unknown>;
  const parsed = step.parse(input);
  if (!parsed.ok) return { type: "continue", snapshot, replies: [parsed.error] };

  const data = step.save(snapshot.data, parsed.value);
  const next = typeof step.next === "function" ? step.next(parsed.value) : step.next;

  if (next === "cancel") {
    return { type: "cancelled", replies: ["No problem. Message REGISTER whenever you'd like to register."] };
  }
  if (next === "complete") {
    if (!isComplete(data)) {
      // Defensive: a missing answer sends the donor back to the start.
      const fresh: Snapshot = { flow: "donor_onboarding", state: "name", history: [], data: {} };
      return { type: "continue", snapshot: fresh, replies: ["Something was missing, so let's go through it again.", prompt(fresh)] };
    }
    return { type: "complete", data, replies: [] };
  }

  // The opening yes/no isn't a step worth going back to.
  const history = snapshot.state === "await_start" ? [] : [...snapshot.history, snapshot.state];
  const advanced: Snapshot = { flow: "donor_onboarding", state: next, history, data };
  return { type: "continue", snapshot: advanced, replies: [prompt(advanced)] };
}
