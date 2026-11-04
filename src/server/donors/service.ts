import "server-only";
import { Types } from "mongoose";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import {
  coarsenLocation,
  type DonorProfileUpdate,
  type DonorRegistrationInput,
  type NotificationAction,
} from "@/features/donors/schemas";
import type { DonorAlertView, DonorOverview, DonorProfileView, NotificationStatus } from "@/features/donors/types";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { isOptedOut } from "@/server/messaging/eligibility";
import { liftOptOut, recordOptOut } from "@/server/messaging/opt-out";
import { ConsentRecord } from "@/server/models/consent-record";
import { DonorProfile, type DonorProfileDoc } from "@/server/models/donor-profile";
import { NotificationEvent } from "@/server/models/notification-event";
import { User, type UserDoc } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { recordAudit } from "@/server/services/audit";

/**
 * Donor business logic. Registration comes only from the WhatsApp bot; the
 * web API manages existing profiles. Channel code calls these functions and
 * never writes donor data directly.
 */

export type Channel = "web" | "whatsapp";

type ProfileDoc = DonorProfileDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type UserLean = UserDoc & { _id: Types.ObjectId };

const isDuplicateKeyError = (error: unknown) => (error as { code?: number })?.code === 11000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const toObjectId = (id: string | Types.ObjectId) => (typeof id === "string" ? new Types.ObjectId(id) : id);

const notRegistered = () => new AppError(404, "DONOR_NOT_REGISTERED", "You haven't registered as a donor yet.");

async function loadUser(userId: Types.ObjectId): Promise<UserLean> {
  const user = await User.findById(userId).lean();
  if (!user || (user.status !== "active" && user.status !== "paused")) {
    throw new AppError(403, "ACCOUNT_UNAVAILABLE", "This account can't be used right now. Please contact MarutiX support.");
  }
  return user as UserLean;
}

export function notificationStatus(profile: Pick<ProfileDoc, "notificationConsentAt" | "notificationConsentWithdrawnAt" | "notificationsPausedAt">, optedOut: boolean): NotificationStatus {
  if (optedOut) return "opted_out";
  if (!profile.notificationConsentAt) return "not_enabled";
  if (profile.notificationConsentWithdrawnAt) return "opted_out";
  if (profile.notificationsPausedAt) return "paused";
  return "active";
}

async function toView(profile: ProfileDoc, user: UserLean): Promise<DonorProfileView> {
  const optedOut = await isOptedOut(user.phoneLookup);
  const coords = profile.location?.coordinates;
  return {
    name: user.displayName ?? "",
    maskedPhone: maskPhone(decryptPii(user.phoneEncrypted)),
    bloodGroup: profile.bloodGroup,
    city: profile.city,
    locality: profile.locality,
    location:
      coords?.length === 2 && profile.locationUpdatedAt
        ? { longitude: coords[0], latitude: coords[1], updatedAt: profile.locationUpdatedAt.toISOString() }
        : null,
    lastDonationDate: profile.lastDonationDate ? isoDate(profile.lastDonationDate) : null,
    availableForRequests: profile.availableForRequests,
    notifications: {
      status: notificationStatus(profile, optedOut),
      consentAt: profile.notificationConsentAt && !profile.notificationConsentWithdrawnAt ? profile.notificationConsentAt.toISOString() : null,
      pausedAt: profile.notificationsPausedAt?.toISOString() ?? null,
    },
    registeredVia: profile.registeredVia,
    registeredAt: profile.registeredAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

async function loadProfile(userId: Types.ObjectId): Promise<ProfileDoc> {
  const profile = await DonorProfile.findOne({ userId }).lean();
  if (!profile) throw notRegistered();
  return profile as ProfileDoc;
}

async function recordConsent(userId: Types.ObjectId, action: "granted" | "paused" | "resumed" | "withdrawn", source: Channel) {
  await ConsentRecord.create({ userId, purpose: "donor_alerts", channel: "whatsapp", action, source, noticeVersion: PRIVACY_NOTICE_VERSION });
}

/* ------------------------------------------------------------------------ */

export async function getDonorOverview(userId: string | Types.ObjectId): Promise<DonorOverview> {
  await connectToDatabase();
  const id = toObjectId(userId);
  const user = await loadUser(id);
  const profile = (await DonorProfile.findOne({ userId: id }).lean()) as ProfileDoc | null;
  const conversation = profile
    ? null
    : await WhatsAppConversation.findOne({ phoneLookup: user.phoneLookup, status: "active" }, { updatedAt: 1 }).lean();
  return {
    name: user.displayName ?? null,
    maskedPhone: maskPhone(decryptPii(user.phoneEncrypted)),
    profile: profile ? await toView(profile, user) : null,
    whatsappOnboarding: conversation
      ? { inProgress: true, updatedAt: (conversation as { updatedAt: Date }).updatedAt.toISOString() }
      : null,
  };
}

/**
 * Creates the donor profile from a completed WhatsApp registration, once per
 * user (and so once per normalised WhatsApp number). Records consent if given.
 */
export async function registerDonor(
  userId: string | Types.ObjectId,
  input: DonorRegistrationInput,
  { requestId }: { requestId: string },
): Promise<DonorProfileView> {
  await connectToDatabase();
  const id = toObjectId(userId);
  const user = await loadUser(id);
  if (await DonorProfile.exists({ userId: id })) {
    throw new AppError(409, "DONOR_ALREADY_REGISTERED", "You're already registered as a donor.");
  }

  const now = new Date();
  const phoneE164 = decryptPii(user.phoneEncrypted);
  const location = input.location ? coarsenLocation(input.location) : null;

  let profile: ProfileDoc;
  try {
    const created = await DonorProfile.create({
      userId: id,
      bloodGroup: input.bloodGroup,
      city: input.city,
      locality: input.locality,
      ...(location ? { location: { type: "Point", coordinates: [location.longitude, location.latitude] }, locationUpdatedAt: now } : {}),
      ...(input.lastDonationDate ? { lastDonationDate: new Date(`${input.lastDonationDate}T00:00:00Z`) } : {}),
      availableForRequests: input.availableForRequests,
      ...(input.notificationConsent ? { notificationConsentAt: now, notificationChannels: ["whatsapp"] } : {}),
      registeredVia: "whatsapp",
      registeredAt: now,
    });
    profile = created.toObject() as ProfileDoc;
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError(409, "DONOR_ALREADY_REGISTERED", "You're already registered as a donor.");
    throw error;
  }

  await User.updateOne({ _id: id }, { $set: { displayName: input.name } });
  user.displayName = input.name;

  await recordAudit({ action: "donor.registered", outcome: "success", requestId, actorUserId: id, resourceType: "donor_profile", resourceId: "whatsapp" });

  if (input.notificationConsent) {
    // Explicit consent also lifts an earlier STOP for this number.
    await liftOptOut(phoneE164, "whatsapp_join");
    await recordConsent(id, "granted", "whatsapp");
    await recordAudit({ action: "donor.notifications_enabled", outcome: "success", requestId, actorUserId: id });
  }

  return toView(profile, user);
}

export async function updateDonorProfile(userId: string | Types.ObjectId, patch: DonorProfileUpdate, requestId: string): Promise<DonorProfileView> {
  await connectToDatabase();
  const id = toObjectId(userId);
  const user = await loadUser(id);
  await loadProfile(id);

  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  if (patch.bloodGroup !== undefined) $set.bloodGroup = patch.bloodGroup;
  if (patch.city !== undefined) $set.city = patch.city;
  if (patch.locality !== undefined) $set.locality = patch.locality;
  if (patch.location === null) Object.assign($unset, { location: 1, locationUpdatedAt: 1 });
  else if (patch.location) {
    const l = coarsenLocation(patch.location);
    $set.location = { type: "Point", coordinates: [l.longitude, l.latitude] };
    $set.locationUpdatedAt = new Date();
  }
  if (patch.lastDonationDate === null) $unset.lastDonationDate = 1;
  else if (patch.lastDonationDate) $set.lastDonationDate = new Date(`${patch.lastDonationDate}T00:00:00Z`);

  if (Object.keys($set).length || Object.keys($unset).length) {
    await DonorProfile.updateOne({ userId: id }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) });
  }
  if (patch.name !== undefined) {
    await User.updateOne({ _id: id }, { $set: { displayName: patch.name } });
    user.displayName = patch.name;
  }

  await recordAudit({
    action: "donor.profile_updated",
    outcome: "success",
    requestId,
    actorUserId: id,
    resourceType: "donor_profile",
    resourceId: `fields:${Object.keys(patch).sort().join(",")}`,
  });
  return toView(await loadProfile(id), user);
}

export async function setAvailability(userId: string | Types.ObjectId, available: boolean, requestId: string): Promise<DonorProfileView> {
  await connectToDatabase();
  const id = toObjectId(userId);
  const user = await loadUser(id);
  const result = await DonorProfile.updateOne({ userId: id }, { $set: { availableForRequests: available } });
  if (result.matchedCount === 0) throw notRegistered();
  await recordAudit({ action: "donor.availability_changed", outcome: "success", requestId, actorUserId: id, resourceId: available ? "available" : "unavailable" });
  return toView(await loadProfile(id), user);
}

/** Enable, pause, resume or opt out of emergency alerts. Opt-out takes effect immediately. */
export async function changeNotifications(
  userId: string | Types.ObjectId,
  action: NotificationAction,
  source: Channel,
  requestId: string,
): Promise<DonorProfileView> {
  await connectToDatabase();
  const id = toObjectId(userId);
  const user = await loadUser(id);
  const profile = await loadProfile(id);
  const phoneE164 = decryptPii(user.phoneEncrypted);
  const status = notificationStatus(profile, await isOptedOut(user.phoneLookup));
  const now = new Date();

  switch (action) {
    case "enable":
      await liftOptOut(phoneE164, source === "web" ? "app" : "whatsapp_join");
      await DonorProfile.updateOne(
        { userId: id },
        { $set: { notificationConsentAt: now, notificationChannels: ["whatsapp"] }, $unset: { notificationConsentWithdrawnAt: 1, notificationsPausedAt: 1 } },
      );
      await recordConsent(id, "granted", source);
      await recordAudit({ action: "donor.notifications_enabled", outcome: "success", requestId, actorUserId: id, resourceId: source });
      break;
    case "pause":
      if (status !== "active") throw new AppError(409, "CONFLICT", "Alerts aren't switched on, so there's nothing to pause.");
      await DonorProfile.updateOne({ userId: id }, { $set: { notificationsPausedAt: now } });
      await recordConsent(id, "paused", source);
      await recordAudit({ action: "donor.notifications_paused", outcome: "success", requestId, actorUserId: id, resourceId: source });
      break;
    case "resume":
      if (status !== "paused") throw new AppError(409, "CONFLICT", "Alerts aren't paused.");
      await DonorProfile.updateOne({ userId: id }, { $unset: { notificationsPausedAt: 1 } });
      await recordConsent(id, "resumed", source);
      await recordAudit({ action: "donor.notifications_resumed", outcome: "success", requestId, actorUserId: id, resourceId: source });
      break;
    case "opt_out":
      await recordOptOut(phoneE164, source === "whatsapp" ? "whatsapp_stop" : "user", now);
      await recordAudit({ action: "donor.notifications_opted_out", outcome: "success", requestId, actorUserId: id, resourceId: source });
      break;
  }
  return toView(await loadProfile(id), user);
}

export async function listDonorAlerts(userId: string | Types.ObjectId): Promise<DonorAlertView[]> {
  await connectToDatabase();
  const docs = await NotificationEvent.find({ recipientUserId: toObjectId(userId), kind: "emergency_request" }, { status: 1, createdAt: 1, sentAt: 1, deliveredAt: 1, readAt: 1 })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  const iso = (d?: Date | null) => (d ? d.toISOString() : null);
  return docs.map((d) => ({
    id: d._id.toString(),
    status: d.status,
    createdAt: (d as { createdAt: Date }).createdAt.toISOString(),
    sentAt: iso(d.sentAt),
    deliveredAt: iso(d.deliveredAt),
    readAt: iso(d.readAt),
  }));
}

/** Moves the account to a new, OTP-verified number. */
export async function changePhoneNumber(userId: string | Types.ObjectId, newLookup: string, encrypted: string, requestId: string) {
  await connectToDatabase();
  const id = toObjectId(userId);
  const user = await loadUser(id);
  if (user.phoneLookup === newLookup) return;
  if (await User.exists({ phoneLookup: newLookup, _id: { $ne: id } })) {
    throw new AppError(409, "PHONE_IN_USE", "This number is already linked to another MarutiX account.");
  }
  try {
    await User.updateOne({ _id: id }, { $set: { phoneLookup: newLookup, phoneEncrypted: encrypted, phoneVerifiedAt: new Date() } });
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError(409, "PHONE_IN_USE", "This number is already linked to another MarutiX account.");
    throw error;
  }
  // Onboarding tied to the old number no longer applies.
  await WhatsAppConversation.updateOne(
    { phoneLookup: user.phoneLookup, status: "active" },
    { $set: { status: "cancelled", cancelledAt: new Date() }, $inc: { version: 1 } },
  );
  await recordAudit({ action: "donor.phone_changed", outcome: "success", requestId, actorUserId: id, resourceType: "user" });
}
