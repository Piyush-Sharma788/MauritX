import "server-only";
import { redactText } from "@/lib/security/redact";

type Level = "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean | null | undefined>;

/**
 * Structured JSON logs. Callers must never pass OTPs, tokens, phone numbers,
 * IP addresses or request bodies; only identifiers and outcomes. String
 * values are also redacted here, in case a library error message carries one.
 */
function write(level: Level, event: string, fields: Fields = {}) {
  const safe: Fields = {};
  for (const [key, value] of Object.entries(fields)) safe[key] = typeof value === "string" ? redactText(value) : value;
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const logger = {
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
