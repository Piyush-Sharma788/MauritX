import { randomInt, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { phoneLookupToken } from "@/lib/security/crypto";
import { OtpChallenge } from "@/server/models/otp-challenge";
import { User } from "@/server/models/user";
import type { OtpDeliveryProvider } from "@/server/otp-delivery";
import { OTP_MAX_VERIFY_ATTEMPTS, requestOtp, verifyOtp } from "@/server/services/otp";
import { createSession, findSessionUser, revokeSession } from "@/server/services/session";
import { findOrCreateVerifiedUser } from "@/server/services/users";

/**
 * Runs the real OTP and session services against MongoDB.
 * Enable with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test npm test
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);

function capturingProvider() {
  const sent: string[] = [];
  const provider: OtpDeliveryProvider = {
    channel: "development",
    async send({ code }) {
      sent.push(code);
      return {};
    },
  };
  return { provider, lastCode: () => sent.at(-1)! };
}

const ctx = (): ApiContext => ({ requestId: randomUUID(), ip: `10.0.${randomInt(255)}.${randomInt(255)}`, userAgent: "vitest" });
const randomPhone = () => `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

/** Moves the latest challenge's creation time back so the resend cooldown has elapsed. */
const skipCooldown = (phone: string) =>
  OtpChallenge.collection.updateMany(
    { phoneLookup: phoneLookupToken(phone) },
    { $set: { createdAt: new Date(Date.now() - 60_000) } },
  );

describe.skipIf(!enabled)("OTP authentication flow (MongoDB)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all([User.syncIndexes(), OtpChallenge.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it("verifies a correct code exactly once and never stores it in plaintext", async () => {
    const phone = randomPhone();
    const { provider, lastCode } = capturingProvider();
    const sent = await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider);

    expect(sent.channel).toBe("development");
    expect(sent.codeLength).toBe(6);

    const stored = await OtpChallenge.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
    expect(JSON.stringify(stored)).not.toContain(lastCode());
    expect(JSON.stringify(stored)).not.toContain(phone.slice(3));

    await expect(verifyOtp({ phoneE164: phone, code: lastCode(), purpose: "login" }, ctx())).resolves.toBeTruthy();
    await expectAppError(verifyOtp({ phoneE164: phone, code: lastCode(), purpose: "login" }, ctx()), "OTP_EXPIRED");
  });

  it("counts wrong attempts and locks the challenge after the limit", async () => {
    const phone = randomPhone();
    const { provider, lastCode } = capturingProvider();
    await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider);

    const first = await expectAppError(
      verifyOtp({ phoneE164: phone, code: wrongCode(lastCode()), purpose: "login" }, ctx()),
      "OTP_INVALID",
    );
    expect(first.details?.attemptsRemaining).toBe(OTP_MAX_VERIFY_ATTEMPTS - 1);

    for (let i = 1; i < OTP_MAX_VERIFY_ATTEMPTS - 1; i++) {
      await expectAppError(verifyOtp({ phoneE164: phone, code: wrongCode(lastCode()), purpose: "login" }, ctx()), "OTP_INVALID");
    }
    await expectAppError(
      verifyOtp({ phoneE164: phone, code: wrongCode(lastCode()), purpose: "login" }, ctx()),
      "OTP_ATTEMPTS_EXCEEDED",
    );
    // Even the right code is refused once locked.
    await expectAppError(verifyOtp({ phoneE164: phone, code: lastCode(), purpose: "login" }, ctx()), "OTP_ATTEMPTS_EXCEEDED");
  });

  it("does not let parallel guesses exceed the attempt limit", async () => {
    const phone = randomPhone();
    const { provider, lastCode } = capturingProvider();
    await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider);

    const guesses = Array.from({ length: 12 }, () =>
      verifyOtp({ phoneE164: phone, code: wrongCode(lastCode()), purpose: "login" }, ctx()).catch((e: AppError) => e.code),
    );
    await Promise.all(guesses);
    const challenge = await OtpChallenge.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
    expect(challenge?.attempts).toBe(OTP_MAX_VERIFY_ATTEMPTS);
  });

  it("enforces the resend cooldown and invalidates the previous code on resend", async () => {
    const phone = randomPhone();
    const { provider, lastCode } = capturingProvider();
    await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider);
    const firstCode = lastCode();

    const tooSoon = await expectAppError(requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider), "OTP_RESEND_TOO_SOON");
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.details?.retryAfterSeconds).toBeGreaterThan(0);

    await skipCooldown(phone);
    await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider);
    if (firstCode !== lastCode()) {
      await expectAppError(verifyOtp({ phoneE164: phone, code: firstCode, purpose: "login" }, ctx()), "OTP_INVALID");
    }
    await expect(verifyOtp({ phoneE164: phone, code: lastCode(), purpose: "login" }, ctx())).resolves.toBeTruthy();
  });

  it("rejects expired codes", async () => {
    const phone = randomPhone();
    const { provider, lastCode } = capturingProvider();
    await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider);
    await OtpChallenge.updateMany({ phoneLookup: phoneLookupToken(phone) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expectAppError(verifyOtp({ phoneE164: phone, code: lastCode(), purpose: "login" }, ctx()), "OTP_EXPIRED");
  });

  it("rate-limits sends per phone number", async () => {
    const phone = randomPhone();
    const { provider } = capturingProvider();
    for (let i = 0; i < 5; i++) {
      await requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider);
      await skipCooldown(phone);
    }
    const limited = await expectAppError(requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), provider), "RATE_LIMITED");
    expect(limited.status).toBe(429);
  });

  it("reports delivery failures honestly and discards the challenge", async () => {
    const phone = randomPhone();
    const failing: OtpDeliveryProvider = {
      channel: "whatsapp",
      async send() {
        throw new Error("provider down");
      },
    };
    const error = await expectAppError(requestOtp({ phoneE164: phone, purpose: "login" }, ctx(), failing), "OTP_DELIVERY_FAILED");
    expect(error.status).toBe(503);
    expect(await OtpChallenge.countDocuments({ phoneLookup: phoneLookupToken(phone) })).toBe(0);
  });

  it("creates one user per phone number, even under concurrent verification", async () => {
    const phone = randomPhone();
    const lookup = phoneLookupToken(phone);
    const results = await Promise.all(Array.from({ length: 5 }, () => findOrCreateVerifiedUser(phone, lookup)));

    expect(new Set(results.map((r) => r.user._id.toString())).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await User.countDocuments({ phoneLookup: lookup })).toBe(1);

    const raw = await User.collection.findOne({ phoneLookup: lookup });
    expect(JSON.stringify(raw)).not.toContain(phone.slice(3));
  });

  it("refuses sign-in for suspended accounts", async () => {
    const phone = randomPhone();
    const lookup = phoneLookupToken(phone);
    const { user } = await findOrCreateVerifiedUser(phone, lookup);
    await User.updateOne({ _id: user._id }, { $set: { status: "suspended" } });
    await expectAppError(findOrCreateVerifiedUser(phone, lookup), "ACCOUNT_UNAVAILABLE");
  });

  it("creates, resolves and revokes sessions", async () => {
    const phone = randomPhone();
    const { user } = await findOrCreateVerifiedUser(phone, phoneLookupToken(phone));
    const session = await createSession(user._id);

    expect((await findSessionUser(session.token))?._id.toString()).toBe(user._id.toString());
    expect(await findSessionUser("not-a-real-token")).toBeNull();

    expect((await revokeSession(session.token))?.toString()).toBe(user._id.toString());
    expect(await findSessionUser(session.token)).toBeNull();
    expect(await revokeSession(session.token)).toBeNull();
  });
});
