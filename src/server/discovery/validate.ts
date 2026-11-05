import "server-only";
import { Resolver } from "node:dns/promises";
import { normaliseEmail, normaliseWebsite } from "@/server/discovery/normalize";
import { safeFetchText, UnsafeUrlError } from "@/server/discovery/safe-fetch";

/**
 * Automatic checks of contact values, before anything is used for outreach.
 * Each answers valid / invalid / unknown with a short reason:
 * - email: syntax, then the domain must accept mail (MX, or A/AAAA as the
 *   RFC 5321 fallback). A domain that does not exist is invalid; a DNS
 *   timeout or server failure is unknown (never treated as invalid).
 * - phone: an Indian number in E.164 form with a plausible leading digit.
 * - website: the URL is public and answers with a non-error status.
 * DNS answers are cached per domain. Reserved documentation/test domains
 * (RFC 2606/6761: .example, .test, .localhost, example.com/net/org) are never
 * looked up and stay unknown; `.invalid` is invalid by definition.
 */

export type ValidationState = "valid" | "invalid" | "unknown";
export interface ValidationResult {
  state: ValidationState;
  reason: string;
}

const DNS_CACHE_TTL_MS = 6 * 60 * 60_000;
const DNS_NEGATIVE_TTL_MS = 30 * 60_000;
const dnsCache = new Map<string, { result: ValidationResult; expiresAt: number }>();

export function clearValidationCacheForTests() {
  dnsCache.clear();
}

const RESERVED = /(^|\.)(example|test|localhost)$|^example\.(com|net|org)$/i;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms))]);
}

const codeOf = (error: unknown) => (error as { code?: string })?.code ?? "";
const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

export async function checkEmailDomain(domain: string, timeoutMs: number, now = Date.now()): Promise<ValidationResult> {
  const host = domain.toLowerCase();
  if (/(^|\.)invalid$/.test(host)) return { state: "invalid", reason: "reserved_invalid_domain" };
  if (RESERVED.test(host)) return { state: "unknown", reason: "reserved_domain_not_checked" };
  const hit = dnsCache.get(host);
  if (hit && hit.expiresAt > now) return hit.result;

  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  let result: ValidationResult;
  try {
    const mx = await withTimeout(resolver.resolveMx(host), timeoutMs).catch((error: unknown) => {
      if (NOT_FOUND.has(codeOf(error))) return [];
      throw error;
    });
    // A "null MX" (RFC 7505: priority 0, exchange ".") means the domain accepts no mail.
    if (mx.length === 1 && (mx[0].exchange === "" || mx[0].exchange === ".")) result = { state: "invalid", reason: "null_mx" };
    else if (mx.length) result = { state: "valid", reason: "mx" };
    else {
      const a = await withTimeout(resolver.resolve4(host), timeoutMs).catch(() => [] as string[]);
      const aaaa = a.length ? [] : await withTimeout(resolver.resolve6(host), timeoutMs).catch(() => [] as string[]);
      result = a.length || aaaa.length ? { state: "valid", reason: "address_record" } : { state: "invalid", reason: "domain_has_no_mail_or_address_records" };
    }
  } catch (error) {
    result = { state: "unknown", reason: `dns_${(codeOf(error) || "error").toLowerCase()}`.slice(0, 40) };
  }
  dnsCache.set(host, { result, expiresAt: now + (result.state === "unknown" ? DNS_NEGATIVE_TTL_MS : DNS_CACHE_TTL_MS) });
  return result;
}

export async function validateEmail(raw: string, timeoutMs: number): Promise<ValidationResult> {
  const email = normaliseEmail(raw);
  if (!email) return { state: "invalid", reason: "syntax" };
  return checkEmailDomain(email.split("@")[1], timeoutMs);
}

/** Indian E.164: mobiles start 6-9; landlines are a 2-4 digit STD code (never starting 0) plus the number. */
export function validatePhone(value: string): ValidationResult {
  if (!/^\+91\d{10}$/.test(value)) return { state: "invalid", reason: "not_indian_e164" };
  const local = value.slice(3);
  if (/^(\d)\1{9}$/.test(local)) return { state: "invalid", reason: "repeated_digits" };
  if (/^0/.test(local)) return { state: "invalid", reason: "leading_zero" };
  return { state: "valid", reason: /^[6-9]/.test(local) ? "mobile_format" : "landline_format" };
}

export async function checkWebsite(raw: string, options: { userAgent: string; timeoutMs: number }): Promise<ValidationResult> {
  const url = normaliseWebsite(raw);
  if (!url) return { state: "invalid", reason: "not_a_url" };
  const host = new URL(url).hostname;
  if (RESERVED.test(host)) return { state: "unknown", reason: "reserved_domain_not_checked" };
  try {
    // GET with a tiny size limit: many sites answer HEAD wrongly.
    const res = await safeFetchText(url, { ...options, maxBytes: 16 * 1024 });
    if (res.status < 400) return { state: "valid", reason: `http_${res.status}` };
    // Exists but refuses robots or needs login: reachable, so not invalid.
    if (res.status === 401 || res.status === 403 || res.status === 429) return { state: "unknown", reason: `http_${res.status}` };
    if (res.status === 404 || res.status === 410) return { state: "invalid", reason: `http_${res.status}` };
    return { state: "unknown", reason: `http_${res.status}` };
  } catch (error) {
    if (error instanceof UnsafeUrlError && /does not resolve/.test(error.message)) return { state: "invalid", reason: "host_does_not_resolve" };
    if (error instanceof UnsafeUrlError) return { state: "invalid", reason: "unsafe_url" };
    return { state: "unknown", reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}
