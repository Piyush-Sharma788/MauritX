import { BLOOD_GROUP_LABELS, locationSchema, type BloodGroup } from "@/features/donors/schemas";
import { parseBloodGroup, isSkip, parseYesNo } from "@/features/donors/parse";
import { formatIstShort, parseComponent, parsePriority, parseRequiredBy, parseUnits } from "@/features/requests/parse";
import {
  COMPONENT_LABELS,
  hospitalStepSchema,
  patientStepSchema,
  PRIORITY_LABELS,
  type Component,
  type Priority,
} from "@/features/requests/schemas";
import { maskPhone, normalizeIndianMobile } from "@/lib/validation/phone";
import type { BotInput } from "@/server/conversations/onboarding-machine";

/**
 * WhatsApp emergency request conversation as a pure state machine. It asks
 * only for what isn't known yet, validates every answer with the same
 * schemas as the web form, shows a numbered summary and completes only on an
 * explicit YES. Prefilled answers (the sender's own number, or details read
 * from their first message) are marked in the summary for the requester to
 * check. No I/O: the bot saves the request through the request service.
 */

export const REQUEST_STATES = [
  "patient_name",
  "patient_age",
  "contact_name",
  "contact_phone",
  "blood_group",
  "component",
  "units",
  "required_by",
  "priority",
  "hospital_name",
  "city",
  "locality",
  "hospital_address",
  "location",
  "confirm",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
type FieldState = Exclude<RequestState, "confirm">;

export interface RequestDraft {
  /** Random per conversation; the request's idempotency key is derived from it. */
  flowId: string;
  patientName?: string;
  patientAge?: number | null;
  contactName?: string;
  contactPhone?: string;
  bloodGroup?: BloodGroup;
  component?: Component;
  unitsRequested?: number;
  requiredBy?: string;
  priority?: Priority;
  hospitalName?: string;
  city?: string;
  locality?: string;
  hospitalAddress?: string;
  location?: { latitude: number; longitude: number } | null;
  /** Fields filled from the requester's own message or number rather than asked; shown for checking. */
  prefilled?: FieldState[];
  /** Editing one field from the summary: return to the summary after it. */
  editing?: boolean;
}

export type CompleteDraft = Required<Omit<RequestDraft, "prefilled" | "editing">> & Pick<RequestDraft, "prefilled">;

export interface RequestSnapshot {
  flow: "emergency_request";
  state: RequestState;
  history: RequestState[];
  data: RequestDraft;
}

export interface RequestContext {
  senderE164: string;
  now: Date;
}

export type RequestOutcome =
  | { type: "continue"; snapshot: RequestSnapshot; replies: string[] }
  | { type: "complete"; draft: CompleteDraft; replies: string[] }
  | { type: "cancelled"; replies: string[] };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

function zodParse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, value: unknown): Parsed<T> {
  const r = schema.safeParse(value);
  return r.success ? ok(r.data) : fail(r.error.issues[0]?.message ?? "Please try again.");
}

const textOnly = <T,>(input: BotInput, parse: (t: string) => Parsed<T>): Parsed<T> =>
  input.type === "text" ? parse(input.text) : fail("Please reply with text for this question.");

interface Step {
  field: keyof RequestDraft;
  label: string;
  prompt(d: RequestDraft, ctx: RequestContext): string;
  parse(input: BotInput, ctx: RequestContext): Parsed<unknown>;
  show(d: RequestDraft): string;
}

const STEPS: Record<FieldState, Step> = {
  patient_name: {
    field: "patientName",
    label: "Patient",
    prompt: () => "What is the patient's name? Initials are fine (for example S. D.). It's seen only by the MarutiX team and never sent to donors.",
    parse: (i) => textOnly(i, (t) => zodParse(patientStepSchema.shape.patientName, t)),
    show: (d) => d.patientName ?? "-",
  },
  patient_age: {
    field: "patientAge",
    label: "Patient age",
    prompt: () => "Patient's age in years? Reply SKIP if you'd rather not say.",
    parse: (i) =>
      textOnly(i, (t) => {
        if (isSkip(t)) return ok(null);
        const n = Number(t.trim().replace(/\s*(YEARS?|YRS?|Y)$/i, ""));
        return Number.isInteger(n) && n >= 0 && n <= 120 ? ok(n) : fail("Please send an age from 0 to 120, or SKIP.");
      }),
    show: (d) => (d.patientAge === null || d.patientAge === undefined ? "Not given" : `${d.patientAge} years`),
  },
  contact_name: {
    field: "contactName",
    label: "Contact person",
    prompt: () => "Your name, so the hospital and our team know whom to speak to?",
    parse: (i) => textOnly(i, (t) => zodParse(patientStepSchema.shape.contactName, t)),
    show: (d) => d.contactName ?? "-",
  },
  contact_phone: {
    field: "contactPhone",
    label: "Contact number",
    prompt: (_d, ctx) => `Which mobile number should we use to reach you? Reply SAME for this WhatsApp number (${maskPhone(ctx.senderE164)}) or send another Indian mobile number.`,
    parse: (i, ctx) =>
      textOnly(i, (t) => {
        if (/^\s*(same|this|this number|yes)\s*$/i.test(t)) return ok(ctx.senderE164);
        const e164 = normalizeIndianMobile(t);
        return e164 ? ok(e164) : fail("Please send a 10-digit Indian mobile number, or SAME for this WhatsApp number.");
      }),
    show: (d) => (d.contactPhone ? maskPhone(d.contactPhone) : "-"),
  },
  blood_group: {
    field: "bloodGroup",
    label: "Blood group",
    prompt: () => "Patient's blood group? Reply A+, A-, B+, B-, AB+, AB-, O+ or O-, or NOT SURE.",
    parse: (i) => textOnly(i, (t) => {
      const g = parseBloodGroup(t);
      return g ? ok(g) : fail("I didn't recognise that blood group. Reply A+, A-, B+, B-, AB+, AB-, O+, O- or NOT SURE.");
    }),
    show: (d) => (d.bloodGroup ? (d.bloodGroup === "unknown" ? "Not sure (the hospital will confirm)" : BLOOD_GROUP_LABELS[d.bloodGroup]) : "-"),
  },
  component: {
    field: "component",
    label: "Component",
    prompt: () => "Which blood component did the hospital ask for?\n1. Whole blood\n2. Packed red cells (PRBC)\n3. Platelets\n4. Plasma (FFP)\n5. Other",
    parse: (i) => textOnly(i, (t) => {
      const c = parseComponent(t);
      return c ? ok(c) : fail("Please reply with a number from 1 to 5.");
    }),
    show: (d) => (d.component ? COMPONENT_LABELS[d.component] : "-"),
  },
  units: {
    field: "unitsRequested",
    label: "Units",
    prompt: () => "How many units are needed? (1 to 20)",
    parse: (i) => textOnly(i, (t) => {
      const n = parseUnits(t);
      return n ? ok(n) : fail("Please send a number of units from 1 to 20.");
    }),
    show: (d) => (d.unitsRequested ? String(d.unitsRequested) : "-"),
  },
  required_by: {
    field: "requiredBy",
    label: "Required by",
    prompt: () => "By when is it needed? For example: NOW, in 3 hours, today 6pm, tomorrow 10am, or 05-11-2026 14:30.",
    parse: (i, ctx) => textOnly(i, (t) => {
      const when = parseRequiredBy(t, ctx.now);
      if (!when) return fail("I couldn't read that time. Try NOW, in 3 hours, today 6pm, tomorrow 10am or 05-11-2026 14:30.");
      const problem = requiredByInRange(when.toISOString(), ctx.now);
      return problem ? fail(problem) : ok(when.toISOString());
    }),
    show: (d) => (d.requiredBy ? formatIstShort(new Date(d.requiredBy)) : "-"),
  },
  priority: {
    field: "priority",
    label: "Urgency",
    prompt: () => "How urgent is it?\n1. Critical: within a few hours\n2. Urgent: within 24 hours\n3. Scheduled: planned procedure",
    parse: (i) => textOnly(i, (t) => {
      const p = parsePriority(t);
      return p ? ok(p) : fail("Please reply 1, 2 or 3.");
    }),
    show: (d) => (d.priority ? PRIORITY_LABELS[d.priority].label : "-"),
  },
  hospital_name: {
    field: "hospitalName",
    label: "Hospital",
    prompt: () => "Name of the hospital where the patient is admitted?",
    parse: (i) => textOnly(i, (t) => zodParse(hospitalStepSchema.shape.hospitalName, t)),
    show: (d) => d.hospitalName ?? "-",
  },
  city: {
    field: "city",
    label: "City",
    prompt: () => "Which city is the hospital in?",
    parse: (i) => textOnly(i, (t) => zodParse(hospitalStepSchema.shape.city, t)),
    show: (d) => d.city ?? "-",
  },
  locality: {
    field: "locality",
    label: "Locality",
    prompt: (d) => `Which area or locality of ${d.city ?? "the city"} is the hospital in?`,
    parse: (i) => textOnly(i, (t) => zodParse(hospitalStepSchema.shape.locality, t)),
    show: (d) => d.locality ?? "-",
  },
  hospital_address: {
    field: "hospitalAddress",
    label: "Hospital address",
    prompt: () => "Hospital address or a landmark (for example: 12 MG Road, near the bus stand)?",
    parse: (i) => textOnly(i, (t) => zodParse(hospitalStepSchema.shape.hospitalAddress, t)),
    show: (d) => d.hospitalAddress ?? "-",
  },
  location: {
    field: "location",
    label: "Hospital location pin",
    prompt: () => "Optional: share the hospital's location so we can find donors nearby. Tap 📎 → Location → send it, or reply SKIP.",
    parse: (i) => {
      if (i.type === "text") return isSkip(i.text) ? ok(null) : fail("Please share a location using 📎 → Location, or reply SKIP.");
      const r = locationSchema.safeParse({ latitude: i.latitude, longitude: i.longitude });
      // About 100 m, like the web form.
      return r.success
        ? ok({ latitude: Math.round(r.data.latitude * 1000) / 1000, longitude: Math.round(r.data.longitude * 1000) / 1000 })
        : fail("That location seems to be outside India. Share another location, or reply SKIP.");
    },
    show: (d) => (d.location ? "Shared (approximate)" : "Not shared"),
  },
};

const FIELD_STATES = REQUEST_STATES.filter((s): s is FieldState => s !== "confirm");

const isSet = (d: RequestDraft, s: FieldState) => d[STEPS[s].field] !== undefined;

/** Same window as the web form's schema (1 hour ago to 30 days ahead), on the conversation's clock. */
export function requiredByInRange(iso: string, now: Date): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "Choose the date and time blood is needed by.";
  if (t < now.getTime() - 60 * 60 * 1000) return "The required-by time can't be in the past.";
  if (t > now.getTime() + 30 * 24 * 60 * 60 * 1000) return "Choose a time within the next 30 days.";
  return null;
}

/** The first question still unanswered, or the summary. */
export function nextState(d: RequestDraft): RequestState {
  return FIELD_STATES.find((s) => !isSet(d, s)) ?? "confirm";
}

function summary(d: RequestDraft): string {
  const prefilled = new Set(d.prefilled ?? []);
  const lines = FIELD_STATES.map((s, i) => `${i + 1}. ${STEPS[s].label}: ${STEPS[s].show(d)}${prefilled.has(s) ? " *" : ""}`);
  return [
    "Please check your blood request:",
    ...lines,
    ...(prefilled.size ? ["* filled in from your message or number. Please check it."] : []),
    "",
    "Reply YES to submit. To change something, reply its number (for example 7). Reply CANCEL to stop.",
    "By replying YES you confirm these details are correct and agree that MarutiX may share the blood need, hospital and area (never the patient's name or your number) with matched donors and verified hospitals. Our team verifies every request with the hospital before any donor is alerted.",
  ].join("\n");
}

export function requestPrompt(s: RequestSnapshot, ctx: RequestContext): string {
  return s.state === "confirm" ? summary(s.data) : STEPS[s.state].prompt(s.data, ctx);
}

const COMMANDS = {
  BACK: ["BACK", "PREVIOUS"],
  CANCEL: ["CANCEL", "QUIT", "EXIT"],
  RESTART: ["RESTART", "START OVER"],
  HELP: ["HELP", "?"],
};
const isCommand = (text: string, list: string[]) => list.includes(text.trim().toUpperCase().replace(/\s+/g, " "));

/**
 * A new request conversation. `known` holds answers that need no question:
 * the requester's verified number and name, or validated details from their
 * first message. They're marked as prefilled.
 */
export function startRequest(flowId: string, known: Partial<Omit<RequestDraft, "flowId">>, ctx: RequestContext): { snapshot: RequestSnapshot; replies: string[] } {
  const data: RequestDraft = { flowId, ...known, prefilled: FIELD_STATES.filter((s) => known[STEPS[s].field as keyof typeof known] !== undefined) };
  const snapshot: RequestSnapshot = { flow: "emergency_request", state: nextState(data), history: [], data };
  const intro = [
    "MarutiX emergency blood request 🩸 I'll ask a few short questions. Reply BACK to go back or CANCEL to stop at any time.",
    "If the patient's life is in danger, call 112 and speak to the hospital's blood bank now. Don't wait for this chat.",
  ].join("\n");
  return { snapshot, replies: [intro, requestPrompt(snapshot, ctx)] };
}

export function advanceRequest(snapshot: RequestSnapshot, input: BotInput, ctx: RequestContext): RequestOutcome {
  const prompt = (s: RequestSnapshot) => requestPrompt(s, ctx);
  if (input.type === "text") {
    if (isCommand(input.text, COMMANDS.CANCEL)) return { type: "cancelled", replies: ["Request cancelled. Nothing was submitted. Send REQUEST whenever you need to start again."] };
    if (isCommand(input.text, COMMANDS.RESTART)) {
      const fresh: RequestSnapshot = { flow: "emergency_request", state: "patient_name", history: [], data: { flowId: snapshot.data.flowId, contactPhone: ctx.senderE164, prefilled: ["contact_phone"] } };
      fresh.state = nextState(fresh.data);
      return { type: "continue", snapshot: fresh, replies: ["Let's start over.", prompt(fresh)] };
    }
    if (isCommand(input.text, COMMANDS.HELP)) {
      return { type: "continue", snapshot, replies: ["You're creating an emergency blood request. Reply BACK to go back, RESTART to start over, CANCEL to stop, or STOP to stop all messages.", prompt(snapshot)] };
    }
    if (isCommand(input.text, COMMANDS.BACK)) {
      const previous = snapshot.history.at(-1);
      if (!previous) return { type: "continue", snapshot, replies: ["This is the first question.", prompt(snapshot)] };
      const back: RequestSnapshot = { ...snapshot, state: previous, history: snapshot.history.slice(0, -1), data: { ...snapshot.data, editing: false } };
      return { type: "continue", snapshot: back, replies: [prompt(back)] };
    }
  }

  if (snapshot.state === "confirm") {
    if (input.type !== "text") return { type: "continue", snapshot, replies: [prompt(snapshot)] };
    const choice = Number(input.text.trim());
    if (Number.isInteger(choice) && choice >= 1 && choice <= FIELD_STATES.length) {
      const field = FIELD_STATES[choice - 1];
      const edit: RequestSnapshot = { ...snapshot, state: field, history: [...snapshot.history, "confirm"], data: { ...snapshot.data, editing: true } };
      return { type: "continue", snapshot: edit, replies: [prompt(edit)] };
    }
    if (parseYesNo(input.text) !== true) {
      return { type: "continue", snapshot, replies: ["Reply YES to submit, a number to change that detail, or CANCEL to stop."] };
    }
    // The conversation may have paused for a while: the time must still be valid.
    if (!snapshot.data.requiredBy || requiredByInRange(snapshot.data.requiredBy, ctx.now)) {
      const again: RequestSnapshot = { ...snapshot, state: "required_by", data: { ...snapshot.data, requiredBy: undefined, editing: true } };
      return { type: "continue", snapshot: again, replies: ["The required-by time has passed or is no longer valid.", prompt(again)] };
    }
    const d = snapshot.data;
    if (nextState(d) !== "confirm") {
      const missing: RequestSnapshot = { ...snapshot, state: nextState(d) };
      return { type: "continue", snapshot: missing, replies: ["Something is missing.", prompt(missing)] };
    }
    const { editing: _editing, ...rest } = d;
    void _editing;
    return { type: "complete", draft: rest as CompleteDraft, replies: [] };
  }

  const step = STEPS[snapshot.state];
  const parsed = step.parse(input, ctx);
  if (!parsed.ok) return { type: "continue", snapshot, replies: [parsed.error] };

  const prefilled = (snapshot.data.prefilled ?? []).filter((f) => f !== snapshot.state);
  const data: RequestDraft = { ...snapshot.data, [step.field]: parsed.value, prefilled };
  // Changing the city makes the old locality meaningless.
  if (snapshot.state === "city" && snapshot.data.city !== parsed.value && snapshot.data.locality !== undefined) data.locality = undefined;

  const next = data.editing && nextState(data) === "confirm" ? "confirm" : nextState(data);
  if (next === "confirm") data.editing = false;
  const advanced: RequestSnapshot = { flow: "emergency_request", state: next, history: [...snapshot.history, snapshot.state], data };
  return { type: "continue", snapshot: advanced, replies: [prompt(advanced)] };
}

export const isRequestState = (s: string): s is RequestState => (REQUEST_STATES as readonly string[]).includes(s);
