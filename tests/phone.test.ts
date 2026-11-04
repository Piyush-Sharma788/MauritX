import { describe, expect, it } from "vitest";
import { sendOtpBodySchema, verifyOtpBodySchema } from "@/features/auth/schemas";
import { formatNationalDigits, maskPhone, normalizeIndianMobile } from "@/lib/validation/phone";

describe("normalizeIndianMobile", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["6000000000", "+916000000000"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each(["", "12345", "5876543210", "98765432101", "+1 415 555 0100", "abcdefghij", "+9198765432"])(
    "rejects %s",
    (input) => {
      expect(normalizeIndianMobile(input)).toBeNull();
    },
  );
});

describe("display helpers", () => {
  it("masks the middle digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91 98XXX XX210");
  });
  it("formats national digits in 5+5 groups", () => {
    expect(formatNationalDigits("9876543210")).toBe("98765 43210");
    expect(formatNationalDigits("987")).toBe("987");
  });
});

describe("request schemas", () => {
  it("normalises the phone and applies defaults", () => {
    expect(sendOtpBodySchema.parse({ phone: "98765 43210" })).toEqual({
      phone: "+919876543210",
      purpose: "login",
      channel: "whatsapp",
    });
  });
  it("rejects unknown fields, including operator injection attempts", () => {
    expect(sendOtpBodySchema.safeParse({ phone: "9876543210", role: "admin" }).success).toBe(false);
    expect(sendOtpBodySchema.safeParse({ phone: { $gt: "" } }).success).toBe(false);
  });
  it("requires exactly six digits for the code", () => {
    expect(verifyOtpBodySchema.safeParse({ phone: "9876543210", code: "123456" }).success).toBe(true);
    for (const code of ["12345", "1234567", "12345a", " 123456", 123456]) {
      expect(verifyOtpBodySchema.safeParse({ phone: "9876543210", code }).success).toBe(false);
    }
  });
});
