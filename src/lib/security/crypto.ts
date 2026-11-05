import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { getEnv } from "@/lib/env";

/**
 * Key usage:
 * - OTP_HASH_SECRET   -> OTP hashes and rate-limit keys (short-lived data; safe to rotate).
 * - AUTH_JWT_SECRET   -> keyed hashes of opaque session tokens. Sessions are server-side
 *                        and revocable; no JWTs are issued. Rotating it signs everyone out.
 * - PII_ENCRYPTION_KEY -> AES-256-GCM for phone numbers and the deterministic phone lookup
 *                        token. Rotating it requires a re-encryption migration.
 */
type KeyPurpose = "otp" | "rate-limit" | "session" | "tracking" | "mfa-recovery" | "phone-lookup" | "phone-encryption";

const keyCache = new Map<KeyPurpose, Buffer>();

function key(purpose: KeyPurpose): Buffer {
  const hit = keyCache.get(purpose);
  if (hit) return hit;
  const env = getEnv();
  const material =
    purpose === "otp" || purpose === "rate-limit"
      ? Buffer.from(env.OTP_HASH_SECRET, "utf8")
      : purpose === "session" || purpose === "tracking" || purpose === "mfa-recovery"
        ? Buffer.from(env.AUTH_JWT_SECRET, "utf8")
        : Buffer.from(env.PII_ENCRYPTION_KEY, "base64");
  const derived = Buffer.from(hkdfSync("sha256", material, "marutix", `marutix:${purpose}:v1`, 32));
  keyCache.set(purpose, derived);
  return derived;
}

function hmac(purpose: KeyPurpose, value: string): string {
  return createHmac("sha256", key(purpose)).update(value, "utf8").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/* ------------------------------- OTP ------------------------------- */

/** Cryptographically secure numeric code, zero-padded. */
export function generateOtp(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, "0");
}

/** Binds the hash to the challenge and phone so a hash cannot be replayed elsewhere. */
export function hashOtp(challengeId: string, phoneLookup: string, code: string): string {
  return hmac("otp", `${challengeId}:${phoneLookup}:${code}`);
}

/* ------------------------------ Phone ------------------------------ */

/** Deterministic keyed token used for unique lookups instead of the plaintext number. */
export function phoneLookupToken(e164: string): string {
  return hmac("phone-lookup", e164);
}

const PII_VERSION = "v1";

export function encryptPii(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("phone-encryption"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PII_VERSION, ...[iv, tag, ciphertext].map((b) => b.toString("base64url"))].join(".");
}

export function decryptPii(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== PII_VERSION || !iv || !tag || !ciphertext) throw new Error("Unsupported PII payload");
  const decipher = createDecipheriv("aes-256-gcm", key("phone-encryption"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/* ----------------------------- Sessions ---------------------------- */

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return hmac("session", token);
}

/* ------------------------- Request tracking ------------------------ */

/** 256-bit random token for request tracking links (43 base64url characters). */
export function generateTrackingToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashTrackingToken(token: string): string {
  return hmac("tracking", token);
}

/** Keyed hash for duplicate detection; reveals nothing about its inputs. */
export function dedupeHash(value: string): string {
  return hmac("rate-limit", `dedupe:${value}`);
}

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U

/** Random, non-sequential public ID like "MX-7K3Q9P2A" (40 bits). */
export function generatePublicRequestId(): string {
  const bytes = randomBytes(8);
  let id = "";
  for (let i = 0; i < 8; i++) id += ID_ALPHABET[bytes[i] % 32];
  return `MX-${id}`;
}

/* ---------------------------- Admin MFA ---------------------------- */

/** Keyed hash of a one-time recovery code (normalised: no dashes, upper case). */
export function hashRecoveryCode(code: string): string {
  return hmac("mfa-recovery", code.replace(/[\s-]/g, "").toUpperCase());
}

/* ---------------------------- Rate limits -------------------------- */

export function rateLimitKey(value: string): string {
  return hmac("rate-limit", value);
}
