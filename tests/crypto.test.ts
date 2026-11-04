import { describe, expect, it } from "vitest";
import {
  decryptPii,
  encryptPii,
  generateOtp,
  hashOtp,
  hashSessionToken,
  phoneLookupToken,
  safeEqual,
} from "@/lib/security/crypto";

describe("OTP generation and hashing", () => {
  it("generates zero-padded numeric codes of the requested length", () => {
    for (let i = 0; i < 500; i++) expect(generateOtp(6)).toMatch(/^\d{6}$/);
  });

  it("binds the hash to the challenge, phone and code", () => {
    const base = hashOtp("challenge-1", "phone-a", "123456");
    expect(hashOtp("challenge-1", "phone-a", "123456")).toBe(base);
    expect(hashOtp("challenge-2", "phone-a", "123456")).not.toBe(base);
    expect(hashOtp("challenge-1", "phone-b", "123456")).not.toBe(base);
    expect(hashOtp("challenge-1", "phone-a", "123457")).not.toBe(base);
    expect(base).not.toContain("123456");
  });

  it("compares in constant time and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("PII protection", () => {
  it("round-trips encrypted phone numbers with a fresh IV each time", () => {
    const a = encryptPii("+919876543210");
    const b = encryptPii("+919876543210");
    expect(a).not.toBe(b);
    expect(a).not.toContain("9876543210");
    expect(decryptPii(a)).toBe("+919876543210");
  });

  it("rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = encryptPii("+919876543210").split(".");
    const flipped = ct[0] === "A" ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    expect(() => decryptPii([v, iv, tag, flipped].join("."))).toThrow();
  });

  it("produces a stable, non-reversible phone lookup token", () => {
    expect(phoneLookupToken("+919876543210")).toBe(phoneLookupToken("+919876543210"));
    expect(phoneLookupToken("+919876543210")).not.toBe(phoneLookupToken("+919876543211"));
    expect(phoneLookupToken("+919876543210")).not.toContain("9876543210");
  });

  it("uses independent keys for different purposes", () => {
    expect(hashSessionToken("same-input")).not.toBe(phoneLookupToken("same-input"));
  });
});
