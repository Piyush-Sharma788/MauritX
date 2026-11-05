/**
 * Last line of defence for anything written to logs or the error store:
 * strips phone numbers, email addresses, one-time codes and token-like
 * strings from free text (mostly error messages from libraries and
 * providers). Callers still must not pass personal data on purpose.
 */

const LOWERCASE_PATH = /^[a-z0-9_.:-]*\/[a-z0-9_./:-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RULES: [RegExp, string | ((match: string) => string)][] = [
  // Bearer / basic credentials and key=value secrets in URLs or messages.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret]"],
  [/\b(token|access_token|code|otp|password|secret|signature|key)=([^&\s"']+)/gi, "$1=[secret]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Long opaque strings: session tokens, API keys, hashes, ciphertext. Kept: UUIDs (request IDs)
  // and lowercase paths such as /api/v1/admin/operations/failed-messages.
  [/[A-Za-z0-9_\-+/=.:]{32,}/g, (m) => (UUID.test(m) || LOWERCASE_PATH.test(m) ? m : "[secret]")],
  // Phone numbers: +91 / 91 / 0 prefixes, spaces or dashes, and any other 10+ digit run.
  [/(?<!\d)(?:(?:\+?91|0)[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, "[phone]"],
  [/\+?\d[\d\s-]{9,}\d/g, "[number]"],
  // One-time codes.
  [/(?<!\d)\d{6}(?!\d)/g, "[code]"],
];

export function redactText(text: string, maxLength = 500): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as string);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
