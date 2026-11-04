import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { getCoordinationOverview } from "@/server/admin/coordination";
import { getRequestCoordination } from "@/server/coordination/admin";
import { controlAutomation } from "@/server/coordination/automation";
import { createDonorContactsLink, markDonorContacted, revealDonorContact } from "@/server/coordination/requester";
import type { DiscoveredInstitution } from "@/server/discovery/normalize";
import type { DiscoveryProvider } from "@/server/discovery/provider";
import { setDiscoveryProviderForTests } from "@/server/discovery/service";
import { addContact, reviewInstitution, setContactStatus, setInstitutionStatus } from "@/server/institutions/service";
import { enqueueJob, retryDeadJob } from "@/server/jobs/queue";
import { runDueJobs } from "@/server/jobs/runner";
import { dispatchNext } from "@/server/messaging/dispatcher";
import { handleInboundMessage } from "@/server/messaging/inbound";
import type { MessagingProvider } from "@/server/messaging/provider";
import { ContactAccessLog } from "@/server/models/contact-access-log";
import { CoordinationEvent } from "@/server/models/coordination-event";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";
import { InstitutionOutreach } from "@/server/models/institution-outreach";
import { Job } from "@/server/models/job";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { RateLimitBucket } from "@/server/models/rate-limit-bucket";
import { RequestResponse } from "@/server/models/request-response";
import { User } from "@/server/models/user";
import { EmailSendError, setEmailProviderForTests, type EmailMessage, type EmailProvider } from "@/server/outreach/email";
import { adminOutreachAction, getOutreachPage, recordInstitutionResponse, unsubscribeOutreachEmail } from "@/server/outreach/service";
import { adminUpdateStatus, getTrackedRequest, resolveTrackingToken } from "@/server/requests/service";
import { updateMessagingSettings } from "@/server/settings/service";
import { randomMobile } from "./helpers/fixtures";

/**
 * Phase 6 acceptance: automated discovery, institutional outreach, zone-wise
 * donor waves, donor acceptance, patient connection and admin control, end to
 * end through the real job runner, conversation engine, MongoDB and outboxes.
 * Only external services are fakes: the discovery source, the email provider
 * and the WhatsApp transport. Nothing is sent anywhere.
 * Enable with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test npm test
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);
const admin = new Types.ObjectId();
const ctx = { requestId: "test", ip: "127.0.0.1", userAgent: "vitest" };
const MIN = 60_000;

// Central Prayagraj; 0.009° of latitude ≈ 1 km.
const ORIGIN = { latitude: 25.4358, longitude: 81.8463 };
const north = (km: number) => ({ latitude: Math.round((ORIGIN.latitude + km * 0.009) * 1e5) / 1e5, longitude: ORIGIN.longitude });

let seq = 0;
const say = (phone: string, text: string, now?: Date) =>
  handleInboundMessage({ providerMessageId: `p6-${randomUUID()}-${seq++}`, fromE164: phone, input: { type: "text", text } }, now);

async function outbox(phone: string) {
  const docs = await NotificationEvent.find({ recipientLookup: phoneLookupToken(phone) }).sort({ createdAt: 1, _id: 1 }).lean();
  return docs.map((d) => ({ kind: d.kind, status: d.status, body: d.bodyEncrypted ? decryptPii(d.bodyEncrypted) : null }));
}
const lastReply = async (phone: string) => (await outbox(phone)).at(-1)?.body ?? "";

function fakeWhatsApp(ready = true) {
  const sent: { phone: string; body: string }[] = [];
  const provider: MessagingProvider = { name: "whatsapp_web", isReady: () => ready, sendText: async (phone, body) => { sent.push({ phone, body }); return { providerMessageId: `wamid-${randomUUID()}` }; } };
  return { provider, sent };
}
async function drainWhatsApp(provider: MessagingProvider, now?: Date) {
  for (let i = 0; i < 300; i++) {
    const r = await dispatchNext(provider, { maxMessagesPerHour: 1000, maxRepliesPerHour: 1000, testRecipients: getWhatsAppWebConfig().testRecipients }, now);
    if (r === "idle" || r === "rate_limited") return;
  }
}

function fakeEmail(behaviour?: (m: EmailMessage) => void) {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = { name: "fake", send: async (m) => { behaviour?.(m); sent.push(m); return { messageId: `<${randomUUID()}@fake>` }; } };
  return { provider, sent };
}

const place = (ref: string, name: string, km: number, extra: Partial<DiscoveredInstitution> = {}): DiscoveredInstitution => ({
  externalRef: ref, name, type: "hospital", capability: "hospital", capabilitySource: "source_tags",
  ...north(km), address: `${km} km Road`, city: "Prayagraj", locality: "Civil Lines", channels: [], sourceUrl: `https://www.openstreetmap.org/${ref.slice(4)}`, ...extra,
});

function fakeDiscovery(places: DiscoveredInstitution[], options: { geocode?: { latitude: number; longitude: number } | null; fail?: boolean } = {}) {
  const calls = { search: 0, geocode: 0 };
  const provider: DiscoveryProvider = {
    name: "openstreetmap",
    async searchNearby() {
      calls.search += 1;
      if (options.fail) throw new Error("Overpass returned 504");
      return places;
    },
    async geocode() {
      calls.geocode += 1;
      return options.geocode === undefined ? ORIGIN : options.geocode;
    },
  };
  return { provider, calls };
}

/** A WhatsApp-created request (the sender is the verified requester), verified and activated by an admin. */
async function activeWhatsAppRequest(group = "B+", units = "1") {
  const requester = randomMobile("9");
  await say(requester, "REQUEST");
  for (const t of ["S. D.", "skip", "Rohit Kumar", group, "1", units, "in 6 hours", "1", "City Hospital", "Prayagraj", "Civil Lines", "12 MG Road", "skip", "yes"]) await say(requester, t);
  const confirmation = await lastReply(requester);
  const manageToken = /\/track\/([A-Za-z0-9_-]{43})/.exec(confirmation)![1];
  const request = (await EmergencyRequest.findOne({ requesterPhoneLookup: phoneLookupToken(requester) }).lean())!;
  await adminUpdateStatus(request.publicRequestId, "verified", "Confirmed with blood bank", admin, ctx);
  await adminUpdateStatus(request.publicRequestId, "active", undefined, admin, ctx);
  return { requester, manageToken, request };
}

async function donorAt(km: number | null, name: string, group = "B+") {
  const phone = randomMobile("7");
  for (const t of ["REGISTER", name, group, "Prayagraj", "Civil Lines", "skip", "skip", "1", "yes", "yes"]) await say(phone, t);
  const user = (await User.findOne({ phoneLookup: phoneLookupToken(phone) }).lean())!;
  if (km !== null) {
    const p = north(km);
    await DonorProfile.updateOne({ userId: user._id }, { $set: { location: { type: "Point", coordinates: [p.longitude, p.latitude] }, locationUpdatedAt: new Date() } });
  }
  return { phone, userId: user._id };
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe.skipIf(!enabled)("Phase 6 workflows (MongoDB, fake external services)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all([User, DonorProfile, EmergencyRequest, NotificationEvent, MessagingOptOut, RequestResponse, Institution, InstitutionContact, InstitutionOutreach, Job, ContactAccessLog, CoordinationEvent, RateLimitBucket].map((m) => m.syncIndexes()));
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    // Every fake place and donor sits around the same point, so each test starts from empty collections.
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  });
  afterEach(() => {
    setDiscoveryProviderForTests(undefined);
    setEmailProviderForTests(undefined);
  });

  it("runs the full workflow: request → discovery → outreach → zone waves → acceptance → patient connection → sharing → admin control", async () => {
    // Steps 3–4: discovery returns two places mapped twice (deduplicated) and one without contacts.
    const discovery = fakeDiscovery([
      place("osm:node/1", "Sangam Blood Centre", 1, { type: "blood_bank", capability: "blood_bank", channels: [{ type: "email", value: "bloodbank@sangam.example", source: "openstreetmap", sourceUrl: "https://www.openstreetmap.org/node/1" }] }),
      place("osm:way/2", "City General Hospital", 3, { channels: [{ type: "email", value: "info@citygeneral.example", source: "openstreetmap", sourceUrl: "https://www.openstreetmap.org/way/2" }] }),
      place("osm:node/3", "Tiny Nursing Home Hospital", 4),
    ]);
    setDiscoveryProviderForTests(discovery.provider);
    const email = fakeEmail();
    setEmailProviderForTests(email.provider);

    const near = await donorAt(2, "Near Donor");
    const mid = await donorAt(8, "Mid Donor");
    await donorAt(30, "Far Donor");

    // Steps 1–2: patient request on WhatsApp, verified and activated by an admin.
    const { requester, manageToken, request } = await activeWhatsAppRequest();
    expect(await Job.countDocuments({ type: "coordinate_request" })).toBe(1);

    const t0 = new Date();
    await runDueJobs("test", t0);
    expect(discovery.calls).toMatchObject({ geocode: 1, search: 1 });
    const geocoded = (await EmergencyRequest.findById(request._id).lean())!;
    expect(geocoded.geocodedLocation?.source).toBe("openstreetmap");
    expect(geocoded.automation).toMatchObject({ status: "running", discoveryStatus: "done" });

    // Contact information is stored with its source and retrieval time; nothing is verified automatically.
    const sangam = (await Institution.findOne({ externalRefs: "osm:node/1" }).lean())!;
    expect(sangam).toMatchObject({ source: "openstreetmap", verificationStatus: "pending", review: { status: "unreviewed" }, capability: "blood_bank" });
    expect(sangam.contactChannels[0]).toMatchObject({ type: "email", value: "bloodbank@sangam.example", source: "openstreetmap", status: "unverified", sourceUrl: "https://www.openstreetmap.org/node/1" });
    expect(sangam.contactChannels[0].retrievedAt).toBeInstanceOf(Date);

    // Step 5: unreviewed discovered emails wait for review; no contact at all is shown as such.
    let outreach = (await getRequestCoordination(request.publicRequestId)).outreach;
    expect(outreach.map((o) => [o.name, o.status])).toEqual([
      ["Sangam Blood Centre", "awaiting_review"],
      ["City General Hospital", "awaiting_review"],
      ["Tiny Nursing Home Hospital", "no_contact"],
    ]);
    expect(email.sent).toHaveLength(0);

    await reviewInstitution(sangam._id.toString(), "approved", "Checked on official website", admin, "t");
    await adminOutreachAction(request.publicRequestId, outreach[0].id, { action: "send" }, admin, "t");
    await runDueJobs("test", new Date());
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe("bloodbank@sangam.example");
    expect(email.sent[0].text).toMatch(/Blood group: B\+[\s\S]*Units required: 1[\s\S]*\/respond\/[A-Za-z0-9_-]{43}/);
    expect(email.sent[0].text).not.toMatch(/S\. D\.|Rohit|9\d{9}/);
    outreach = (await getRequestCoordination(request.publicRequestId)).outreach;
    expect(outreach[0]).toMatchObject({ status: "sent", deliveries: [{ channel: "email", status: "sent" }], response: null });

    // Steps 6–7: zone-wise waves. Wave 1 reaches only the 0–5 km zone.
    const wa = fakeWhatsApp();
    await drainWhatsApp(wa.provider);
    const alertTo = (phone: string) => wa.sent.filter((m) => m.phone === phone && m.body.includes("URGENT BLOOD REQUEST"));
    expect(alertTo(near.phone)).toHaveLength(1);
    expect(alertTo(near.phone)[0].body).toMatch(/Distance: approximately 2 km/);
    expect(alertTo(mid.phone)).toHaveLength(0);

    // No reply within the interval: wave 2 expands to 5–10 km. The near donor isn't alerted twice.
    await runDueJobs("test", new Date(t0.getTime() + 25 * MIN));
    await drainWhatsApp(wa.provider);
    expect(alertTo(mid.phone)).toHaveLength(1);
    expect(alertTo(near.phone)).toHaveLength(1);
    const afterWave2 = (await getRequestCoordination(request.publicRequestId)).automation;
    expect(afterWave2.waves.map((w) => w.zone)).toEqual(["0–5 km", "5–10 km"]);
    expect(await CoordinationEvent.exists({ requestId: request._id, type: "donor_zone_expanded" })).not.toBeNull();

    // Step 8: the near donor accepts and agrees to share contact.
    await say(near.phone, "1");
    await say(near.phone, "YES");
    expect(await RequestResponse.countDocuments({ requestId: request._id })).toBe(1);

    // Step 9: the WhatsApp requester (a number WhatsApp verified) gets the donor's approved details.
    const update = (await outbox(requester)).find((m) => m.kind === "requester_update");
    expect(update?.body).toMatch(new RegExp(`Good news![\\s\\S]*Donor name: Near[\\s\\S]*Contact: \\${near.phone.replace("+", "+?")}[\\s\\S]*${request.publicRequestId}`));
    expect(await ContactAccessLog.exists({ requestId: request._id, action: "sent_by_whatsapp" })).not.toBeNull();

    // Step 10: the web manage link lists the donor; the number is revealed only on request, and logged.
    const view = await getTrackedRequest(manageToken);
    const donor = view.coordination!.donors![0];
    expect(donor).toMatchObject({ firstName: "Near", contactAvailable: true });
    expect(JSON.stringify(view)).not.toContain(near.phone);
    expect(view.coordination!.institutions[0]).toMatchObject({ name: "Sangam Blood Centre", contacted: true, response: null });
    const { request: managed, link: manageLink } = await resolveTrackingToken(manageToken);
    expect((await revealDonorContact(managed, donor.responseId)).phone).toBe(near.phone);
    await markDonorContacted(managed, donor.responseId);
    expect((await RequestResponse.findById(donor.responseId).lean())?.requesterContactedAt).toBeInstanceOf(Date);

    // Step 11: share with one responsible person through a short-lived link; every view is logged.
    const share = await createDonorContactsLink(managed, manageLink.expiresAt, 6);
    const shared = await getTrackedRequest(share.token);
    expect(shared.donorContacts).toEqual([expect.objectContaining({ firstName: "Near", phone: near.phone })]);
    expect(shared.coordination).toBeNull();
    expect(shared.manage).toBeNull();
    expect(await ContactAccessLog.countDocuments({ requestId: request._id, action: { $in: ["revealed", "share_link_viewed", "share_link_created"] } })).toBe(3);

    // The institution answers through its secure link.
    const respondToken = /\/respond\/([A-Za-z0-9_-]{43})/.exec(email.sent[0].text)![1];
    expect((await getOutreachPage(respondToken)).institutionName).toBe("Sangam Blood Centre");
    await recordInstitutionResponse(respondToken, { response: "can_assist", contactName: "Dr Rao", contactPhone: "0532 2256507" });
    const tracked = await getTrackedRequest(manageToken);
    expect(tracked.coordination!.institutions[0].response).toMatchObject({ status: "can_assist" });
    expect((await outbox(requester)).some((m) => m.body?.includes("may be able to assist"))).toBe(true);

    // Step 12: the admin overview counts each state separately.
    const row = (await getCoordinationOverview()).rows.find((r) => r.publicRequestId === request.publicRequestId)!;
    expect(row).toMatchObject({ institutionsDiscovered: 3, institutionsContacted: 1, institutionsResponded: 1, institutionsCanAssist: 1, outreachAwaitingReview: 1, donorsNotified: 2, donorsInterested: 1, awaitingCoordination: 1, donationsConfirmed: 0, automation: "running" });

    // Admin pauses, then cancels: no further waves, pending jobs cancelled.
    await controlAutomation(request.publicRequestId, "pause", admin, "t");
    await runDueJobs("test", new Date(t0.getTime() + 60 * MIN));
    expect((await getRequestCoordination(request.publicRequestId)).automation.waves).toHaveLength(2);
    await controlAutomation(request.publicRequestId, "resume", admin, "t");
    await controlAutomation(request.publicRequestId, "cancel", admin, "t");
    await runDueJobs("test", new Date(t0.getTime() + 90 * MIN));
    expect((await EmergencyRequest.findById(request._id).lean())?.automation?.status).toBe("cancelled");
    expect(await Job.countDocuments({ "payload.requestId": request._id.toString(), status: "queued" })).toBe(0);
  });

  it("protects donor contacts from unauthorised access", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([]).provider);
    const donor = await donorAt(1, "Private Donor");
    const sharer = await donorAt(1, "Sharing Donor");
    const { manageToken, request } = await activeWhatsAppRequest();
    await runDueJobs("test", new Date());
    await drainWhatsApp(fakeWhatsApp().provider);
    await say(donor.phone, "1");
    await say(donor.phone, "NO");
    await say(sharer.phone, "1");
    await say(sharer.phone, "YES");

    const { request: managed, link } = await resolveTrackingToken(manageToken);
    const view = await getTrackedRequest(manageToken);
    const privateOne = view.coordination!.donors!.find((d) => !d.contactAvailable)!;
    expect(privateOne.firstName).toBe("A registered donor");
    await expectAppError(revealDonorContact(managed, privateOne.responseId), "NOT_FOUND");
    await expectAppError(revealDonorContact(managed, new Types.ObjectId().toString()), "NOT_FOUND");

    // A response from another request can't be revealed through this request's link.
    const other = await activeWhatsAppRequest("B+");
    await expectAppError(revealDonorContact((await resolveTrackingToken(other.manageToken)).request, view.coordination!.donors!.find((d) => d.contactAvailable)!.responseId), "NOT_FOUND");

    // Family (view) links see no donors; a revoked contacts link stops working.
    const { createFamilyLink, revokeFamilyLink } = await import("@/server/requests/service");
    const family = await createFamilyLink(manageToken, request.publicRequestId, 24, ctx);
    const familyView = await getTrackedRequest(/\/track\/([A-Za-z0-9_-]{43})/.exec(family.url)![1]);
    expect(familyView.coordination!.donors).toBeNull();
    expect(familyView.donorContacts).toBeNull();
    const contacts = await createDonorContactsLink(managed, link.expiresAt, 24);
    await revokeFamilyLink(manageToken, request.publicRequestId, contacts.id, ctx);
    await expectAppError(getTrackedRequest(contacts.token), "TRACKING_LINK_REVOKED");
    expect(await ContactAccessLog.exists({ action: "share_link_revoked" })).not.toBeNull();
  });

  it("web requesters get a nudge, never donor numbers, because their phone number wasn't verified", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([]).provider);
    const donor = await donorAt(1, "Web Donor");
    const { createRequest } = await import("@/server/requests/service");
    const contactPhone = randomMobile("6");
    const created = await createRequest(
      { patientName: "A. B.", patientAge: null, contactName: "Meena Devi", contactPhone, bloodGroup: "B+", component: "whole_blood", unitsRequested: 1, requiredBy: new Date(Date.now() + 6 * 3600_000), priority: "critical", hospitalName: "City Hospital", hospitalAddress: "12 MG Road", city: "Prayagraj", locality: "Civil Lines", hospitalPhone: null, location: ORIGIN, whatsappUpdates: true, consent: true, privacyNoticeVersion: "2026-11-04" },
      randomUUID(), ctx,
    );
    await adminUpdateStatus(created.publicRequestId, "verified", undefined, admin, ctx);
    await adminUpdateStatus(created.publicRequestId, "active", undefined, admin, ctx);
    await runDueJobs("test", new Date());
    await drainWhatsApp(fakeWhatsApp().provider);
    await say(donor.phone, "1");
    await say(donor.phone, "YES");
    const messages = await outbox(contactPhone);
    const nudge = messages.find((m) => m.kind === "requester_update");
    expect(nudge?.body).toMatch(/Open the private tracking link/);
    expect(messages.some((m) => m.body?.includes(donor.phone))).toBe(false);
  });

  it("handles invalid contacts, a missing email provider and transient failures honestly", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([
      place("osm:node/11", "Bad Address Blood Bank", 1, { type: "blood_bank", capability: "blood_bank", channels: [{ type: "email", value: "nobody@bounce.example", source: "openstreetmap" }] }),
      place("osm:node/12", "Flaky Mail Hospital", 2, { channels: [{ type: "email", value: "desk@flaky.example", source: "openstreetmap" }] }),
    ]).provider);
    // Unreviewed records are never contacted unless the operator opts in; approve both.
    const { request } = await activeWhatsAppRequest();
    setEmailProviderForTests(null);
    await runDueJobs("test", new Date());
    for (const ref of ["osm:node/11", "osm:node/12"]) await reviewInstitution((await Institution.findOne({ externalRefs: ref }).lean())!._id.toString(), "approved", undefined, admin, "t");

    // No email provider: shown as unavailable, never as sent.
    const before = (await getRequestCoordination(request.publicRequestId)).outreach;
    await expectAppError(adminOutreachAction(request.publicRequestId, before[0].id, { action: "send" }, admin, "t"), "NOT_RETRYABLE");
    expect((await getRequestCoordination(request.publicRequestId)).outreach[0].status).toBe("channel_unavailable");

    let flakyFailures = 1;
    setEmailProviderForTests(fakeEmail((m) => {
      if (m.to.endsWith("@bounce.example")) throw new EmailSendError("REJECTED", false);
      if (m.to.endsWith("@flaky.example") && flakyFailures-- > 0) throw new EmailSendError("TRANSIENT", true);
    }).provider);
    for (const o of before) await adminOutreachAction(request.publicRequestId, o.id, { action: "send" }, admin, "t");
    const t = new Date();
    await runDueJobs("test", t);
    await runDueJobs("test", new Date(t.getTime() + 2 * MIN)); // first retry after backoff
    const after = (await getRequestCoordination(request.publicRequestId)).outreach;
    const bad = after.find((o) => o.name === "Bad Address Blood Bank")!;
    const flaky = after.find((o) => o.name === "Flaky Mail Hospital")!;
    expect(bad).toMatchObject({ status: "failed", deliveries: [{ status: "failed", failureCode: "REJECTED" }] });
    expect(bad.channels[0].status).toBe("invalid");
    expect(flaky).toMatchObject({ status: "sent" });

    // Retrying a failed one with only an invalid address sends nothing.
    await expectAppError(adminOutreachAction(request.publicRequestId, bad.id, { action: "retry" }, admin, "t"), "NOT_RETRYABLE");
  });

  it("an institution can stop outreach email; later requests skip that address", async () => {
    const places = [place("osm:node/21", "Unsubscribing Blood Bank", 1, { type: "blood_bank", capability: "blood_bank", channels: [{ type: "email", value: "stop@bb.example", source: "openstreetmap" }] })];
    setDiscoveryProviderForTests(fakeDiscovery(places).provider);
    const email = fakeEmail();
    setEmailProviderForTests(email.provider);
    process.env.OUTREACH_INCLUDE_UNREVIEWED = "true";
    const { resetCoordinationConfigForTests } = await import("@/lib/coordination/config");
    resetCoordinationConfigForTests();
    try {
      await activeWhatsAppRequest();
      await runDueJobs("test", new Date());
      expect(email.sent).toHaveLength(1);
      const token = /\/respond\/([A-Za-z0-9_-]{43})/.exec(email.sent[0].text)![1];
      expect(await unsubscribeOutreachEmail(token)).toEqual({ unsubscribed: 1 });

      const second = await activeWhatsAppRequest("B+", "2");
      await runDueJobs("test", new Date());
      expect(email.sent).toHaveLength(1);
      const status = (await getRequestCoordination(second.request.publicRequestId)).outreach[0].status;
      expect(status).toBe("no_contact");
    } finally {
      delete process.env.OUTREACH_INCLUDE_UNREVIEWED;
      resetCoordinationConfigForTests();
    }
  });

  it("verified institutions get outreach on WhatsApp and can answer ASSIST", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([place("osm:node/31", "Verified Blood Bank", 1, { type: "blood_bank", capability: "blood_bank" })]).provider);
    const { request } = await activeWhatsAppRequest();
    await runDueJobs("test", new Date());
    const inst = (await Institution.findOne({ externalRefs: "osm:node/31" }).lean())!;
    // Only after an admin verifies it and its contact does it get WhatsApp access.
    const staff = randomMobile("6");
    await say(staff, `ASSIST ${request.publicRequestId}`);
    expect(await lastReply(staff)).toMatch(/isn't authorised/);
    await setInstitutionStatus(inst._id.toString(), "verified", undefined, admin, "t");
    await addContact(inst._id.toString(), { name: "Dr Verma", phone: staff, role: "staff" }, admin, "t");
    await setContactStatus(inst._id.toString(), (await InstitutionContact.findOne({ phoneLookup: phoneLookupToken(staff) }).lean())!._id.toString(), "verified", admin, "t");
    const outreach = (await getRequestCoordination(request.publicRequestId)).outreach[0];
    await adminOutreachAction(request.publicRequestId, outreach.id, { action: "send" }, admin, "t");
    expect((await outbox(staff)).some((m) => m.kind === "coordinator_alert" && m.body?.includes(`ASSIST ${request.publicRequestId}`))).toBe(true);

    await say(staff, `ASSIST ${request.publicRequestId}`);
    expect(await lastReply(staff)).toMatch(/may be able to assist/);
    expect((await getRequestCoordination(request.publicRequestId)).outreach[0].response).toMatchObject({ status: "can_assist", source: "whatsapp" });
  });

  it("STOP removes a donor from later waves; closing a request stops all outreach", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([place("osm:node/41", "Closing Blood Bank", 1, { type: "blood_bank", capability: "blood_bank", channels: [{ type: "email", value: "close@bb.example", source: "openstreetmap" }] })]).provider);
    const email = fakeEmail();
    setEmailProviderForTests(email.provider);
    const a = await donorAt(2, "Stops Donor");
    const b = await donorAt(7, "Later Donor");
    const { request } = await activeWhatsAppRequest();
    const t0 = new Date();
    await runDueJobs("test", t0);
    await say(b.phone, "STOP");
    await runDueJobs("test", new Date(t0.getTime() + 25 * MIN));
    expect(await NotificationEvent.countDocuments({ requestId: request._id.toString(), kind: "emergency_request", recipientUserId: b.userId, status: { $ne: "suppressed" } })).toBe(0);
    expect(await NotificationEvent.countDocuments({ requestId: request._id.toString(), kind: "emergency_request", recipientUserId: a.userId })).toBe(1);

    // Approve and queue an email, then cancel the request before it goes out.
    const inst = (await Institution.findOne({ externalRefs: "osm:node/41" }).lean())!;
    await reviewInstitution(inst._id.toString(), "approved", undefined, admin, "t");
    const o = (await getRequestCoordination(request.publicRequestId)).outreach[0];
    await adminOutreachAction(request.publicRequestId, o.id, { action: "send" }, admin, "t");
    await adminUpdateStatus(request.publicRequestId, "cancelled", "Arranged elsewhere", admin, ctx);
    await runDueJobs("test", new Date(t0.getTime() + 30 * MIN));
    expect(email.sent).toHaveLength(0);
    const closed = (await EmergencyRequest.findById(request._id).lean())!;
    expect(closed.automation?.status).toBe("completed");
    expect(await NotificationEvent.countDocuments({ requestId: request._id.toString(), kind: "emergency_request", status: "queued" })).toBe(0);
    expect(await Job.countDocuments({ "payload.requestId": request._id.toString(), status: "queued" })).toBe(0);
  });

  it("expired requests stop waves; no institutions or donors is reported, not hidden", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([]).provider);
    const { request, manageToken } = await activeWhatsAppRequest("AB-");
    const t0 = new Date();
    await runDueJobs("test", t0);
    const state = (await getRequestCoordination(request.publicRequestId)).automation;
    expect(state.donorPhase).toBe("exhausted");
    const history = (await getTrackedRequest(manageToken)).coordination!.history.map((h) => h.summary).join("\n");
    expect(history).toMatch(/No hospitals or blood banks with usable details were found nearby/);
    expect(history).toMatch(/contacted every matching registered donor/);

    const other = await activeWhatsAppRequest("B+", "2");
    await donorAt(1, "After Expiry Donor");
    await EmergencyRequest.updateOne({ _id: other.request._id }, { $set: { expiresAt: new Date(t0.getTime() - 1000) } });
    await runDueJobs("test", new Date());
    expect(await NotificationEvent.countDocuments({ requestId: other.request._id.toString(), kind: "emergency_request" })).toBe(0);
  });

  it("keeps working when discovery fails, defers waves while alerts are paused, and dead-letters broken jobs", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([], { fail: true }).provider);
    const donor = await donorAt(1, "Paused Donor");
    await updateMessagingSettings({ alertsPaused: true }, admin, "t");
    const { request } = await activeWhatsAppRequest();
    const t0 = new Date();
    await runDueJobs("test", t0);
    expect((await EmergencyRequest.findById(request._id).lean())?.automation?.discoveryStatus).toBe("failed");
    // Paused: the wave is deferred, not lost.
    expect(await NotificationEvent.countDocuments({ requestId: request._id.toString(), kind: "emergency_request" })).toBe(0);
    const deferred = await Job.findOne({ type: "donor_wave", "payload.requestId": request._id.toString() }).lean();
    expect(deferred).toMatchObject({ status: "queued", attempts: 0 });
    await updateMessagingSettings({ alertsPaused: false }, admin, "t");
    await runDueJobs("test", new Date(t0.getTime() + 6 * MIN));
    expect(await NotificationEvent.countDocuments({ requestId: request._id.toString(), kind: "emergency_request", recipientUserId: donor.userId })).toBe(1);

    // A job that keeps failing is retried with backoff, then dead-lettered, and can be retried by an admin.
    await enqueueJob("donor_wave", `broken:${randomUUID()}`, { requestId: "not-an-id", wave: 1 }, { maxAttempts: 2 });
    let now = new Date(t0.getTime() + 10 * MIN);
    for (let i = 0; i < 3; i++) {
      await runDueJobs("test", now);
      now = new Date(now.getTime() + 10 * MIN);
    }
    const dead = (await Job.findOne({ "payload.requestId": "not-an-id" }).lean())!;
    expect(dead).toMatchObject({ status: "dead", attempts: 2 });
    expect(dead.lastError).toMatch(/CastError/);
    await retryDeadJob(dead._id.toString());
    expect((await Job.findById(dead._id).lean())?.status).toBe("queued");
  });

  it("concurrent acceptances from different donors are each counted once", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([]).provider);
    const donors = await Promise.all([donorAt(1, "Con One"), donorAt(1.5, "Con Two"), donorAt(2, "Con Three")]);
    const { request } = await activeWhatsAppRequest("B+", "3");
    await runDueJobs("test", new Date());
    await drainWhatsApp(fakeWhatsApp().provider);
    await Promise.all(donors.flatMap((d) => [say(d.phone, "1"), say(d.phone, "1")]));
    expect(await RequestResponse.countDocuments({ requestId: request._id })).toBe(3);
    expect((await EmergencyRequest.findById(request._id).lean())?.responseStats?.interested).toBe(3);
  });

  it("WhatsApp disconnection holds alerts in the outbox instead of losing or faking them", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([]).provider);
    const donor = await donorAt(1, "Offline Donor");
    const { request } = await activeWhatsAppRequest();
    await runDueJobs("test", new Date());
    const offline = fakeWhatsApp(false);
    // The worker only dispatches while connected; nothing is marked sent meanwhile.
    expect(offline.provider.isReady()).toBe(false);
    const alert = await NotificationEvent.findOne({ requestId: request._id.toString(), recipientUserId: donor.userId }).lean();
    expect(alert?.status).toBe("queued");
    const online = fakeWhatsApp();
    await drainWhatsApp(online.provider);
    expect(online.sent.filter((m) => m.phone === donor.phone && m.body.includes("URGENT"))).toHaveLength(1);
  });

  it("after a WhatsApp outage lets alerts expire unsent, the next wave re-arms them instead of skipping those donors", async () => {
    setDiscoveryProviderForTests(fakeDiscovery([]).provider);
    const donor = await donorAt(1, "Outage Donor");
    const { request } = await activeWhatsAppRequest();
    const t0 = new Date();
    await runDueJobs("test", t0);
    // WhatsApp was down for two hours: the dispatcher's sweep fails the stale alert as EXPIRED.
    await dispatchNext(fakeWhatsApp(false).provider, { maxMessagesPerHour: 1000, maxRepliesPerHour: 1000, testRecipients: getWhatsAppWebConfig().testRecipients }, new Date(t0.getTime() + 120 * MIN));
    expect(await NotificationEvent.findOne({ requestId: request._id.toString(), recipientUserId: donor.userId }).lean()).toMatchObject({ status: "failed", failureCode: "EXPIRED" });

    await controlAutomation(request.publicRequestId, "run_wave_now", admin, "t", new Date(t0.getTime() + 121 * MIN));
    await runDueJobs("test", new Date(t0.getTime() + 121 * MIN));
    const online = fakeWhatsApp();
    await drainWhatsApp(online.provider, new Date(t0.getTime() + 122 * MIN));
    expect(online.sent.filter((m) => m.phone === donor.phone && m.body.includes("URGENT"))).toHaveLength(1);
    // Delivered now, so a later wave won't alert them again.
    await controlAutomation(request.publicRequestId, "run_wave_now", admin, "t", new Date(t0.getTime() + 150 * MIN));
    await runDueJobs("test", new Date(t0.getTime() + 150 * MIN));
    await drainWhatsApp(online.provider, new Date(t0.getTime() + 151 * MIN));
    expect(online.sent.filter((m) => m.phone === donor.phone && m.body.includes("URGENT"))).toHaveLength(1);
  });
});
