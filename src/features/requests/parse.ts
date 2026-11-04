import type { Component, Priority } from "@/features/requests/schemas";

/**
 * Forgiving, deterministic parsers for emergency-request answers typed on
 * WhatsApp. Each returns null when the text can't be understood, so the bot
 * asks again. Browser-safe.
 */

const norm = (t: string) => t.trim().toUpperCase().replace(/[\s.,]+/g, " ").trim();

const COMPONENT_WORDS: [Component, RegExp][] = [
  ["packed_red_cells", /^(2|PRBC|PRC|PCV|RBC|PACKED( RED)?( CELLS?)?|RED CELLS?|PACKED CELL VOLUME)$/],
  ["platelets", /^(3|PLATELETS?|PLT|SDP|RDP|PLATELET CONCENTRATE)$/],
  ["plasma", /^(4|PLASMA|FFP|FRESH FROZEN PLASMA)$/],
  ["whole_blood", /^(1|WHOLE( BLOOD)?|WB|BLOOD)$/],
  ["other", /^(5|OTHER|CRYO|CRYOPRECIPITATE)$/],
];

export function parseComponent(text: string): Component | null {
  const t = norm(text);
  for (const [component, pattern] of COMPONENT_WORDS) if (pattern.test(t)) return component;
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10,
  EK: 1, DO: 2, TEEN: 3, CHAR: 4, PAANCH: 5,
};

/** "2", "2 units", "two", "do" -> 2. Whole numbers 1–20 only. */
export function parseUnits(text: string): number | null {
  const t = norm(text).replace(/\s*(UNITS?|BAGS?|BOTTLES?|PINTS?)$/, "");
  const n = /^\d{1,2}$/.test(t) ? Number(t) : NUMBER_WORDS[t];
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

export function parsePriority(text: string): Priority | null {
  const t = norm(text);
  if (/^(1|CRITICAL|EMERGENCY|VERY URGENT|LIFE THREATENING)$/.test(t)) return "critical";
  if (/^(2|URGENT|TODAY|WITHIN 24 HOURS)$/.test(t)) return "urgent";
  if (/^(3|SCHEDULED|PLANNED|LATER|NOT URGENT|SURGERY)$/.test(t)) return "scheduled";
  return null;
}

/* ------------------------------------------------------------------------ */
/* Required-by times, always in India Standard Time (UTC+05:30, no DST).     */
/* ------------------------------------------------------------------------ */

const IST_OFFSET_MS = 330 * 60 * 1000;

interface Wall {
  y: number;
  m: number; // 1-12
  d: number;
}

function istWall(now: Date): Wall & { h: number; min: number } {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes() };
}

function fromIst(day: Wall, h: number, min: number): Date | null {
  const ms = Date.UTC(day.y, day.m - 1, day.d, h, min) - IST_OFFSET_MS;
  const check = new Date(ms + IST_OFFSET_MS);
  // Reject impossible dates like 31-02.
  if (check.getUTCDate() !== day.d || check.getUTCMonth() + 1 !== day.m) return null;
  return new Date(ms);
}

const addDays = (day: Wall, n: number): Wall => {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** "6pm", "6:30 pm", "18:00", "1830 hrs" -> [18, 30]. */
function parseClock(t: string): [number, number] | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(AM|PM|HRS|HOURS|BAJE)?$/.exec(t.trim());
  if (!m) {
    const compact = /^(\d{2})(\d{2})\s*HRS$/.exec(t.trim());
    return compact ? clock(Number(compact[1]), Number(compact[2])) : null;
  }
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (suffix === "AM" || suffix === "PM") {
    if (h < 1 || h > 12) return null;
    if (suffix === "AM" && h === 12) h = 0;
    if (suffix === "PM" && h !== 12) h += 12;
  } else if (!suffix && !m[2] && h <= 12) {
    // A bare "6" is ambiguous; require am/pm or hh:mm.
    return null;
  }
  return clock(h, min);
}

const clock = (h: number, min: number): [number, number] | null => (h >= 0 && h <= 23 && min >= 0 && min <= 59 ? [h, min] : null);

const PARTS_OF_DAY: Record<string, [number, number]> = {
  MORNING: [9, 0], SUBAH: [9, 0], NOON: [12, 0], AFTERNOON: [14, 0], DOPAHAR: [14, 0], EVENING: [18, 0], SHAAM: [18, 0], TONIGHT: [21, 0], NIGHT: [21, 0], RAAT: [21, 0],
};

/**
 * Parses a required-by answer relative to `now`. Returns null when unclear.
 * Date-only answers mean 09:00 IST that day (the earlier, safer reading);
 * the bot always shows its interpretation back for confirmation.
 */
export function parseRequiredBy(text: string, now: Date): Date | null {
  const t = text
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[!,]+$|\.$/g, "")
    .replace(/\bP\.M\b\.?/g, "PM")
    .replace(/\bA\.M\b\.?/g, "AM")
    .replace(/^(BY|BEFORE|AT|ON|WITHIN)\s+/, "");
  const today = istWall(now);

  if (/^(NOW|ASAP|IMMEDIATELY|RIGHT NOW|URGENT|ABHI|TURANT|EMERGENCY)$/.test(t)) return new Date(now.getTime());

  const rel = /^(?:IN\s+)?(\d{1,2}|AN|A|ONE|TWO|THREE|FOUR|FIVE|SIX)\s*(HOURS?|HRS?|H|MINUTES?|MINS?|M|DAYS?)$/.exec(t);
  if (rel) {
    const words: Record<string, number> = { AN: 1, A: 1, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6 };
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : words[rel[1]];
    const unit = rel[2].startsWith("D") ? 24 * 60 : rel[2].startsWith("H") ? 60 : 1;
    return new Date(now.getTime() + n * unit * 60_000);
  }

  // "today 6pm", "tomorrow morning", "kal 10 am", "tonight"
  const dayWord = /^(TODAY|AAJ|TOMORROW|TMRW|TMR|KAL|TONIGHT)\b\s*(.*)$/.exec(t);
  if (dayWord) {
    const offset = /^(TOMORROW|TMRW|TMR|KAL)$/.test(dayWord[1]) ? 1 : 0;
    const rest = dayWord[2].replace(/^(AT|BY)\s+/, "").trim();
    const day = addDays(today, offset);
    if (dayWord[1] === "TONIGHT" && !rest) return fromIst(day, 21, 0);
    if (!rest) return offset ? fromIst(day, 9, 0) : new Date(now.getTime() + 4 * 60 * 60_000);
    const part = PARTS_OF_DAY[rest];
    const c = part ?? parseClock(rest);
    return c ? fromIst(day, c[0], c[1]) : null;
  }

  if (PARTS_OF_DAY[t]) {
    const [h, min] = PARTS_OF_DAY[t];
    const candidate = fromIst(today, h, min)!;
    return candidate.getTime() > now.getTime() ? candidate : fromIst(addDays(today, 1), h, min);
  }

  // Just a time: today if still ahead, otherwise tomorrow.
  const onlyClock = parseClock(t);
  if (onlyClock) {
    const candidate = fromIst(today, onlyClock[0], onlyClock[1])!;
    return candidate.getTime() > now.getTime() - 30 * 60_000 ? candidate : fromIst(addDays(today, 1), onlyClock[0], onlyClock[1]);
  }

  // "05-11-2026 14:30", "5/11/2026 2 PM", "05-11 6pm", "2026-11-05"
  const dated = /^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?(?:\s+(.+))?$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(.+))?$/.exec(t);
  let day: Wall | null = null;
  let rest: string | undefined;
  if (iso) {
    day = { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
    rest = iso[4];
  } else if (dated) {
    const y = dated[3] ? (dated[3].length === 2 ? 2000 + Number(dated[3]) : Number(dated[3])) : today.y;
    day = { y, m: Number(dated[2]), d: Number(dated[1]) };
    rest = dated[4];
  }
  if (day) {
    const c = rest ? (PARTS_OF_DAY[rest.trim()] ?? parseClock(rest)) : ([9, 0] as [number, number]);
    if (!c) return null;
    let result = fromIst(day, c[0], c[1]);
    // "05-11" without a year that has already passed means next year.
    if (result && dated && !dated[3] && result.getTime() < now.getTime() - 24 * 60 * 60_000) result = fromIst({ ...day, y: day.y + 1 }, c[0], c[1]);
    return result;
  }
  return null;
}

const istFormat = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
export const formatIstShort = (d: Date) => `${istFormat.format(d)} IST`;
