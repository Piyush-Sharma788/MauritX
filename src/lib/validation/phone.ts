/**
 * Indian mobile number helpers. Shared by the browser and the server, so this
 * module must stay free of server-only imports.
 */

export const INDIA_COUNTRY_CODE = "+91";

/** Indian mobile numbers are 10 digits and start with 6, 7, 8 or 9. */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Strips everything except digits and drops a leading +91 / 91 / 0 prefix.
 * An explicit "+" means a country code was typed, so it must be +91.
 */
export function toNationalDigits(input: string): string {
  let digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) return digits.startsWith("91") ? digits.slice(2) : "";
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export function isValidIndianMobile(nationalDigits: string): boolean {
  return INDIAN_MOBILE.test(nationalDigits);
}

/** Returns the E.164 form (+91XXXXXXXXXX) or null when the input is not a valid Indian mobile number. */
export function normalizeIndianMobile(input: string): string | null {
  const digits = toNationalDigits(input);
  return isValidIndianMobile(digits) ? `${INDIA_COUNTRY_CODE}${digits}` : null;
}

/** "+919876543210" -> "+91 98XXX XX210" */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/^\+91/, "");
  if (digits.length !== 10) return "+91 XXXXX XXXXX";
  return `+91 ${digits.slice(0, 2)}XXX XX${digits.slice(7)}`;
}

/** "9876543210" -> "98765 43210" for display while typing. */
export function formatNationalDigits(digits: string): string {
  const d = digits.slice(0, 10);
  return d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d;
}
