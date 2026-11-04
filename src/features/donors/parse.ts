import { lastDonationDateSchema, type BloodGroup } from "@/features/donors/schemas";

/**
 * Forgiving parsers for free-text WhatsApp replies. Each returns null when
 * the text can't be understood, so the bot can ask again.
 */

const normalise = (text: string) => text.trim().toUpperCase().replace(/[\s.]+/g, " ");

const YES = new Set(["YES", "Y", "YEAH", "YEP", "OK", "OKAY", "SURE", "HAAN", "HA", "HAN", "1"]);
const NO = new Set(["NO", "N", "NAH", "NOPE", "NAHI", "NAHIN", "2"]);

export function parseYesNo(text: string): boolean | null {
  const t = normalise(text);
  if (YES.has(t)) return true;
  if (NO.has(t)) return false;
  return null;
}

const SKIP = new Set(["SKIP", "NOT SURE", "NOTSURE", "DON'T KNOW", "DONT KNOW", "DONT REMEMBER", "NEVER", "NONE", "NA", "N/A", "PREFER NOT TO SAY", "NO"]);

export function isSkip(text: string): boolean {
  return SKIP.has(normalise(text));
}

/** Accepts "O+", "o positive", "O +ve", "AB NEG", "b-", "not sure". */
export function parseBloodGroup(text: string): BloodGroup | null {
  const t = normalise(text).replace(/\s+/g, "");
  if (["NOTSURE", "UNKNOWN", "DONTKNOW", "DON'TKNOW", "IDONTKNOW", "NOTKNOWN"].includes(t)) return "unknown";
  const match = /^(AB|A|B|O|0)(\+|-|−|POS|POSITIVE|\+VE|NEG|NEGATIVE|-VE|−VE)$/.exec(t);
  if (!match) return null;
  const group = match[1] === "0" ? "O" : match[1];
  const sign = /^(\+|POS|POSITIVE|\+VE)$/.test(match[2]) ? "+" : "-";
  return `${group}${sign}` as BloodGroup;
}

/**
 * Accepts DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY or YYYY-MM-DD. Returns an ISO
 * date ("YYYY-MM-DD"), or null if it isn't a valid past date.
 */
export function parseDonationDate(text: string): string | null {
  const t = text.trim();
  let iso: string | null = null;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (dmy) iso = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  else if (ymd) iso = `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  return iso && lastDonationDateSchema.safeParse(iso).success ? iso : null;
}

/** 1 / AVAILABLE / YES -> true, 2 / NOT NOW / NO -> false. */
export function parseAvailability(text: string): boolean | null {
  const t = normalise(text);
  if (["1", "AVAILABLE", "AVAILABLE NOW", "YES", "Y"].includes(t)) return true;
  if (["2", "NOT NOW", "NOT AVAILABLE", "UNAVAILABLE", "NO", "N", "LATER"].includes(t)) return false;
  return null;
}
