import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { setAiProviderForTests } from "@/server/ai/interpret";
import type { AiProvider } from "@/server/ai/provider";
import { retryFailedAlert, sendAlertBatch } from "@/server/coordination/alerts";
import { listResponses, updateCoordination } from "@/server/coordination/responses";
import { addContact, createInstitution, linkRequestInstitution, setContactStatus, setInstitutionStatus } from "@/server/institutions/service";
import { runMatching } from "@/server/matching/service";
import { readMetrics } from "@/server/metrics/bot-metrics";
import { dispatchNext, MAX_SEND_ATTEMPTS } from "@/server/messaging/dispatcher";
import { handleInboundMessage } from "@/server/messaging/inbound";
import { MessagingError, type MessagingProvider } from "@/server/messaging/provider";
import { queueEmergencyRequestNotification } from "@/server/messaging/queue";
import { AuditLog } from "@/server/models/audit-log";
import { AvailabilityReport } from "@/server/models/availability-report";
import { BotMetric } from "@/server/models/bot-metric";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { InstitutionContact } from "@/server/models/institution-contact";
import { MatchingRun } from "@/server/models/matching-run";
import { MessagingOptOut } from "@/server/models/messaging-opt-out";
import { NotificationEvent } from "@/server/models/notification-event";
import { RateLimitBucket } from "@/server/models/rate-limit-bucket";
import { RequestResponse } from "@/server/models/request-response";
import { SystemSetting } from "@/server/models/system-setting";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { WhatsAppInboundMessage } from "@/server/models/whatsapp-inbound-message";
import { adminUpdateStatus } from "@/server/requests/service";
import { updateMessagingSettings } from "@/server/settings/service";
import { alertSummaryFor, createActiveRequest, randomMobile } from "./helpers/fixtures";

/**
 * Phase 5 acceptance workflows A–E, end to end through the real inbound
 * pipeline, conversation engine, MongoDB and outbox. Only WhatsApp itself
 * (the provider) and, where noted, the AI provider are fakes. No real
 * messages are sent.
 * Enable with: MONGODB_URI_TEST=mongodb://127.0.0.1:27017/marutix_test npm test
 */
const enabled = Boolean(process.env.MONGODB_URI_TEST);
const admin = new Types.ObjectId();
const ctx = { requestId: "test", ip: "127.0.0.1", userAgent: "vitest" };

let seq = 0;
const say = (phone: string, text: string, now?: Date) =>
  handleInboundMessage({ providerMessageId: `wf-${randomUUID()}-${seq++}`, fromE164: phone, input: { type: "text", text } }, now);

async function repliesTo(phone: string) {
  const docs = await NotificationEvent.find({ recipientLookup: phoneLookupToken(phone) }).sort({ createdAt: 1, _id: 1 }).lean();
  return docs.map((d) => ({ kind: d.kind, status: d.status, body: d.bodyEncrypted ? decryptPii(d.bodyEncrypted) : null }));
}
const lastReply = async (phone: string) => (await repliesTo(phone)).at(-1)?.body ?? "";
const allReplies = async (phone: string) => (await repliesTo(phone)).map((r) => r.body ?? "").join("\n---\n");

function fakeWhatsApp(behaviour?: (phone: string) => void) {
  const sent: { phone: string; body: string }[] = [];
  const provider: MessagingProvider = {
    name: "whatsapp_web",
    isReady: () => true,
    async sendText(phone, body) {
      behaviour?.(phone);
      sent.push({ phone, body });
      return { providerMessageId: `wamid-${randomUUID()}` };
    },
  };
  return { provider, sent };
}

const dispatchOptions = (extra: { alertsPaused?: boolean } = {}) => ({
  maxMessagesPerHour: 1000,
  maxRepliesPerHour: 1000,
  testRecipients: getWhatsAppWebConfig().testRecipients,
  ...extra,
});

async function drain(provider: MessagingProvider, extra: { alertsPaused?: boolean } = {}) {
  for (let i = 0; i < 200; i++) {
    const outcome = await dispatchNext(provider, dispatchOptions(extra));
    if (outcome === "idle" || outcome === "rate_limited") return;
  }
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

/** Registers a donor through the real WhatsApp bot. */
async function registerOnWhatsApp(name = "Priya Singh", group = "B+", city = "Prayagraj") {
  const phone = randomMobile("7");
  for (const t of ["REGISTER", name, group, city, "Civil Lines", "skip", "skip", "1", "yes", "yes"]) await say(phone, t);
  const user = await User.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
  return { phone, userId: user!._id };
}

async function verifiedInstitution(contacts: { phone: string; role: "coordinator" | "staff" }[]) {
  const inst = await createInstitution(
    { type: "hospital", legalName: "City Hospital Pvt Ltd", displayName: "City Hospital", address: "12 MG Road", city: "Prayagraj", locality: "Civil Lines", publicPhone: null, licenceReference: "UP-12345" },
    admin,
    "t",
  );
  await setInstitutionStatus(inst.id, "verified", undefined, admin, "t");
  for (const c of contacts) {
    await addContact(inst.id, { name: `Dr ${c.role}`, phone: c.phone, role: c.role }, admin, "t");
    const doc = await InstitutionContact.findOne({ phoneLookup: phoneLookupToken(c.phone) }).lean();
    await setContactStatus(inst.id, doc!._id.toString(), "verified", admin, "t");
  }
  return inst;
}

describe.skipIf(!enabled)("Phase 5 workflows (MongoDB, fake WhatsApp)", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all(
      [User, DonorProfile, EmergencyRequest, NotificationEvent, MessagingOptOut, WhatsAppConversation, WhatsAppInboundMessage, RequestResponse, MatchingRun, Institution, InstitutionContact, AvailabilityReport, RateLimitBucket, AuditLog].map((m) =>
        m.syncIndexes(),
      ),
    );
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await SystemSetting.deleteMany({});
    await RateLimitBucket.deleteMany({});
  });
  afterEach(() => setAiProviderForTests(undefined));

  describe("Workflow A: patient creates and tracks a request on WhatsApp", () => {
    it("understands natural language, collects and validates details, confirms, saves and tracks", async () => {
      const phone = randomMobile("9");
      await say(phone, "Need O positive blood urgently in Prayagraj.");
      const intro = await allReplies(phone);
      expect(intro).toMatch(/emergency blood request/);
      expect(intro).toMatch(/patient's name/);

      // Blood group, city and time came from the message; the contact number from WhatsApp.
      for (const t of ["S. D.", "54", "Rohit Kumar", "2", "two", "1", "City Hospital", "Civil Lines", "12 MG Road", "skip"]) await say(phone, t);
      const summary = await lastReply(phone);
      expect(summary).toMatch(/Blood group: O\+ \*/);
      expect(summary).toMatch(/City: Prayagraj \*/);
      expect(summary).toMatch(/Contact number: \+91 9\dXXX XX\d{3} \*/);
      expect(await EmergencyRequest.countDocuments({ requesterPhoneLookup: phoneLookupToken(phone) })).toBe(0);

      await say(phone, "8"); // change "required by"
      await say(phone, "in 3 hours");
      await say(phone, "YES");
      const confirmation = await lastReply(phone);
      const request = await EmergencyRequest.findOne({ requesterPhoneLookup: phoneLookupToken(phone) }).lean();
      expect(request).toMatchObject({ status: "pending_verification", createdVia: "whatsapp", bloodGroup: "O+", component: "packed_red_cells", unitsRequested: 2, city: "Prayagraj", priority: "critical" });
      expect(decryptPii(request!.patientNameEncrypted)).toBe("S. D.");
      expect(confirmation).toContain(request!.publicRequestId);
      expect(confirmation).toMatch(/http:\/\/localhost:3000\/track\/[A-Za-z0-9_-]{43}/);
      expect(confirmation).toMatch(/Pending verification/);

      await say(phone, "TRACK");
      const tracked = (await repliesTo(phone)).at(-2)?.body ?? "";
      expect(tracked).toMatch(new RegExp(`${request!.publicRequestId}: Pending verification[\\s\\S]*Verified by MarutiX: Not yet`));
      expect(tracked).not.toMatch(/S\. D\./);
    });

    it("prevents duplicate submissions and lets only the creating number cancel", async () => {
      const phone = randomMobile("9");
      const fill = async () => {
        await say(phone, "REQUEST");
        for (const t of ["A. K.", "skip", "Meena Devi", "B-", "3", "1", "tomorrow 10am", "2", "District Hospital", "Lucknow", "Hazratganj", "Near GPO", "skip", "yes"]) await say(phone, t);
      };
      await fill();
      await fill();
      expect(await lastReply(phone)).toMatch(/already have an open request/);
      expect(await EmergencyRequest.countDocuments({ requesterPhoneLookup: phoneLookupToken(phone) })).toBe(1);

      const other = randomMobile("9");
      await say(other, "CANCEL");
      expect(await lastReply(other)).toMatch(/don't have an open request/);

      await say(phone, "cancel");
      expect(await lastReply(phone)).toMatch(/Reply YES to cancel/);
      await say(phone, "yes");
      expect(await lastReply(phone)).toMatch(/is cancelled/);
      expect((await EmergencyRequest.findOne({ requesterPhoneLookup: phoneLookupToken(phone) }).lean())?.status).toBe("cancelled");
    });

    it("uses AI entities only after validation, and never acts on AI for consent", async () => {
      const fake: AiProvider = {
        name: "fake",
        async interpret(text) {
          expect(text).not.toMatch(/98765/);
          return {
            intent: text.includes("stop") ? "stop_messages" : "create_request",
            entities: { bloodGroup: "A negative", component: "platelets", units: 2, city: "Varanasi", locality: null, hospitalName: "<b>bad</b>", requiredBy: "tomorrow morning", requestId: null },
            confidence: 0.92,
            missing_fields: ["patient_name"],
            requires_confirmation: true,
            suggested_response: "Okay!",
          };
        },
      };
      setAiProviderForTests(fake);
      const phone = randomMobile("9");
      await say(phone, "kal subah do unit platelets chahiye, Varanasi. call 9876543210");
      const convo = await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
      expect(convo?.flow).toBe("emergency_request");
      const data = JSON.parse(decryptPii(convo!.dataEncrypted));
      expect(data).toMatchObject({ bloodGroup: "A-", component: "platelets", unitsRequested: 2, city: "Varanasi" });
      expect(data.hospitalName).toBeUndefined();

      const donor = randomMobile("9");
      await say(donor, "please stop these");
      expect(await lastReply(donor)).toMatch(/Reply STOP to confirm/);
      expect(await MessagingOptOut.exists({ phoneLookup: phoneLookupToken(donor) })).toBeNull();
    });

    it("falls back to keywords when the AI fails or returns malformed output", async () => {
      const before = (await readMetrics()).today;
      setAiProviderForTests({ name: "broken", interpret: async () => ({ intent: "launch_rockets" }) });
      const a = randomMobile("9");
      await say(a, "I want to register as a donor");
      expect(await allReplies(a)).toMatch(/register you as a voluntary blood donor/);

      setAiProviderForTests({ name: "down", interpret: async () => { throw new Error("timeout"); } });
      const b = randomMobile("9");
      await say(b, "need B+ blood urgently");
      expect((await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(b) }).lean())?.flow).toBe("emergency_request");

      const after = (await readMetrics()).today;
      expect((after.ai_rejected_output ?? 0) - (before.ai_rejected_output ?? 0)).toBe(1);
      expect((after.ai_errors ?? 0) - (before.ai_errors ?? 0)).toBe(1);
    });
  });

  describe("Workflow B: donor registers, gets an authorised alert and responds", () => {
    it("registers, shows the profile, receives an alert, says INTERESTED once, and the coordinator is told", async () => {
      const donor = await registerOnWhatsApp();
      await say(donor.phone, "PROFILE");
      expect(await lastReply(donor.phone)).toMatch(/MarutiX donor: Priya Singh[\s\S]*Blood group: B\+/);
      await say(donor.phone, "STATUS");
      expect(await lastReply(donor.phone)).toMatch(/Emergency alerts: On/);

      const coordinatorPhone = randomMobile("6");
      const inst = await verifiedInstitution([{ phone: coordinatorPhone, role: "coordinator" }]);
      const request = await createActiveRequest();
      await linkRequestInstitution(request.publicRequestId, inst.id, admin, "t");

      const run = await runMatching(request.publicRequestId, 10, admin, "t");
      expect(run.candidates.map((c) => c.donorFirstName)).toContain("Priya");
      const batch = await sendAlertBatch(request.publicRequestId, run.id, admin, "t");
      expect(batch.queued).toBeGreaterThanOrEqual(1);

      const { provider, sent } = fakeWhatsApp();
      await drain(provider);
      const alert = sent.find((m) => m.phone === donor.phone && m.body.includes("URGENT BLOOD REQUEST"))!;
      expect(alert.body).toMatch(/URGENT BLOOD REQUEST[\s\S]*Blood group: B\+[\s\S]*City Hospital[\s\S]*1 — I am interested[\s\S]*3 — Contact me later/);
      expect(alert.body).not.toMatch(/S\. D\.|Rohit/);
      expect(alert.body).toContain(request.publicRequestId);

      await say(donor.phone, "1");
      expect(await lastReply(donor.phone)).toMatch(/May we share your first name, area and WhatsApp number[\s\S]*the patient's family/);
      await say(donor.phone, "yes");
      expect(await lastReply(donor.phone)).toMatch(/Next steps/);

      const responses = await RequestResponse.find({ requestId: request._id }).lean();
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({ response: "interested", coordinationStatus: "interested" });
      expect(responses[0].contactSharingConsentAt).toBeInstanceOf(Date);
      const coordinatorMsg = await NotificationEvent.findOne({ kind: "coordinator_alert", recipientLookup: phoneLookupToken(coordinatorPhone) }).lean();
      expect(decryptPii(coordinatorMsg!.bodyEncrypted!)).toContain(donor.phone);

      // Duplicate response is recognised, not double counted.
      await say(donor.phone, "INTERESTED");
      expect(await lastReply(donor.phone)).toMatch(/already have your reply/);
      expect(await RequestResponse.countDocuments({ requestId: request._id })).toBe(1);
      expect((await EmergencyRequest.findById(request._id).lean())?.responseStats).toMatchObject({ interested: 1, unavailable: 0 });

      // Interest isn't a donation until a coordinator moves it forward, step by step.
      const [view] = await listResponses(request._id);
      expect(view.donorPhone).toBe(donor.phone);
      await expectAppError(updateCoordination(request.publicRequestId, view.id, "donation_confirmed", { type: "admin", userId: admin }, undefined, "t"), "INVALID_TRANSITION");
      await updateCoordination(request.publicRequestId, view.id, "coordinator_contacted", { type: "admin", userId: admin }, "Called donor", "t");
      await updateCoordination(request.publicRequestId, view.id, "hospital_coordination", { type: "admin", userId: admin }, undefined, "t");
      await updateCoordination(request.publicRequestId, view.id, "donation_confirmed", { type: "admin", userId: admin }, undefined, "t");
      expect((await RequestResponse.findById(view.id).lean())?.coordinationHistory).toHaveLength(4);
    });

    it("MORE INFO answers with details; UNAVAILABLE is recorded and replaces interest", async () => {
      const donor = await registerOnWhatsApp("Kavya Rao");
      const request = await createActiveRequest();
      await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(request) });
      await drain(fakeWhatsApp().provider);

      await say(donor.phone, "4");
      expect(await lastReply(donor.phone)).toMatch(/Address: 12 MG Road[\s\S]*Only the blood centre can decide/);
      await say(donor.phone, "1");
      await say(donor.phone, "2");
      expect(await lastReply(donor.phone)).toMatch(/won't ask you about/);
      expect(await RequestResponse.findOne({ requestId: request._id }).lean()).toMatchObject({ response: "unavailable", coordinationStatus: "not_proceeding" });
      expect((await EmergencyRequest.findById(request._id).lean())?.responseStats).toMatchObject({ interested: 0, unavailable: 1 });
      // The open contact-sharing question was closed.
      expect((await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(donor.phone) }).lean())?.status).not.toBe("active");
    });
  });

  describe("Workflow C: matching for a verified, active request", () => {
    it("enforces consent and preferences, ranks by distance and never re-alerts", async () => {
      const at = (lat: number) => ({ type: "Point" as const, coordinates: [81.85, lat] });
      const near = await registerOnWhatsApp("Near Donor");
      const far = await registerOnWhatsApp("Far Donor");
      const paused = await registerOnWhatsApp("Paused Donor");
      const stopped = await registerOnWhatsApp("Stopped Donor");
      const mismatch = await registerOnWhatsApp("Other Group", "O-");
      await DonorProfile.updateOne({ userId: near.userId }, { $set: { location: at(25.45) } });
      await DonorProfile.updateOne({ userId: far.userId }, { $set: { location: at(25.6) } });
      await say(paused.phone, "PAUSE");
      await say(stopped.phone, "STOP");

      const pending = await createActiveRequest({ status: "pending_verification" });
      await expectAppError(runMatching(pending.publicRequestId, 10, admin, "t"), "INVALID_TRANSITION");

      const request = await createActiveRequest({ location: { type: "Point", coordinates: [81.85, 25.44] } });
      const small = await runMatching(request.publicRequestId, 10, admin, "t");
      const names = small.candidates.map((c) => c.donorFirstName);
      expect(names[0]).toBe("Near");
      expect(names).not.toContain("Far");
      expect(names).not.toContain("Paused");
      expect(names).not.toContain("Stopped");
      expect(names).not.toContain("Other");
      expect(small.excluded).toMatchObject({ alerts_paused: 1, opted_out: 1, blood_group_not_matched: 1 });
      expect(small.policyReviewStatus).toBe("pending_clinical_review");

      const wide = await runMatching(request.publicRequestId, 25, admin, "t");
      expect(wide.candidates.map((c) => c.donorFirstName)).toEqual(expect.arrayContaining(["Near", "Far"]));
      const first = await sendAlertBatch(request.publicRequestId, wide.id, admin, "t");
      const second = await sendAlertBatch(request.publicRequestId, wide.id, admin, "t");
      expect(first.queued).toBe(wide.candidates.length);
      expect(second.queued).toBe(0);
      const rerun = await runMatching(request.publicRequestId, 25, admin, "t");
      expect(rerun.candidates).toHaveLength(0);
      expect(rerun.excluded.already_contacted).toBe(wide.candidates.length);
      void mismatch;
    });

    it("refuses to send while alerts are paused", async () => {
      const request = await createActiveRequest();
      const run = await runMatching(request.publicRequestId, 10, admin, "t");
      await updateMessagingSettings({ alertsPaused: true }, admin, "t");
      await expectAppError(sendAlertBatch(request.publicRequestId, run.id, admin, "t"), "ALERTS_PAUSED");
    });
  });

  describe("Workflow D: institutional coordination", () => {
    it("rejects unverified numbers, lets verified contacts acknowledge and report, and limits fulfilment to coordinators", async () => {
      const stranger = randomMobile("6");
      await say(stranger, "REQUESTS");
      expect(await lastReply(stranger)).toMatch(/isn't authorised/);

      const coordinator = randomMobile("6");
      const staff = randomMobile("6");
      const pendingInst = await createInstitution(
        { type: "blood_bank", legalName: "Pending BB", displayName: "Pending BB", address: "1 Station Road", city: "Prayagraj", locality: "Civil Lines", publicPhone: null, licenceReference: null },
        admin,
        "t",
      );
      const request = await createActiveRequest();
      await expectAppError(linkRequestInstitution(request.publicRequestId, pendingInst.id, admin, "t"), "INSTITUTION_NOT_VERIFIED");

      // A verified contact of an unverified institution has no access either.
      const pendingContact = randomMobile("6");
      await addContact(pendingInst.id, { name: "Dr Pending", phone: pendingContact, role: "coordinator" }, admin, "t");
      const pc = await InstitutionContact.findOne({ phoneLookup: phoneLookupToken(pendingContact) }).lean();
      await setContactStatus(pendingInst.id, pc!._id.toString(), "verified", admin, "t");
      await say(pendingContact, `ACK ${request.publicRequestId}`);
      expect(await lastReply(pendingContact)).toMatch(/isn't authorised/);

      const inst = await verifiedInstitution([{ phone: coordinator, role: "coordinator" }, { phone: staff, role: "staff" }]);
      await linkRequestInstitution(request.publicRequestId, inst.id, admin, "t");

      await say(staff, "REQUESTS");
      expect(await lastReply(staff)).toContain(request.publicRequestId);
      await say(staff, `ACK ${request.publicRequestId}`);
      expect(await lastReply(staff)).toMatch(/Acknowledged/);
      expect((await EmergencyRequest.findById(request._id).lean())?.institutionAcknowledgedAt).toBeInstanceOf(Date);

      await say(staff, "AVAILABLE O+ PRBC 3");
      expect(await lastReply(staff)).toMatch(/not as confirmed live stock/);
      expect(await AvailabilityReport.findOne({ institutionId: inst.id }).lean()).toMatchObject({ bloodGroup: "O+", component: "packed_red_cells", units: 3, status: "available", source: "whatsapp" });

      // Queue an alert, then confirm fulfilment: staff can't, the coordinator can, and alerts stop.
      const donor = await registerOnWhatsApp("Late Donor");
      await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(request) });
      await say(staff, `FULFILLED ${request.publicRequestId}`);
      expect(await lastReply(staff)).toMatch(/Only your institution's verified coordinator/);
      await say(coordinator, `FULFILLED ${request.publicRequestId}`);
      const closed = await EmergencyRequest.findById(request._id).lean();
      expect(closed?.status).toBe("fulfilled");
      expect(closed?.history.at(-1)).toMatchObject({ status: "fulfilled", actor: "institution" });
      expect(await NotificationEvent.countDocuments({ requestId: request._id.toString(), kind: "emergency_request", status: "queued" })).toBe(0);

      // A revoked contact loses access immediately.
      const sc = await InstitutionContact.findOne({ phoneLookup: phoneLookupToken(staff) }).lean();
      await setContactStatus(inst.id, sc!._id.toString(), "revoked", admin, "t");
      await say(staff, "REQUESTS");
      expect(await lastReply(staff)).toMatch(/isn't authorised/);
    });
  });

  describe("Workflow E: reliability", () => {
    it("recovers conversations after a restart and ignores duplicate deliveries", async () => {
      const phone = randomMobile("9");
      await say(phone, "REQUEST");
      await say(phone, "S. D.");

      // Simulate a worker restart: a fresh process with a new connection and no in-memory state.
      await mongoose.disconnect();
      (globalThis as { __marutixMongoose?: unknown }).__marutixMongoose = undefined;
      await connectToDatabase();
      await say(phone, "skip", new Date(Date.now() + 2 * 60 * 60 * 1000));
      expect(await lastReply(phone)).toMatch(/Your name/);

      const id = `dup-${randomUUID()}`;
      const msg = { providerMessageId: id, fromE164: phone, input: { type: "text" as const, text: "Rohit Kumar" } };
      expect(await handleInboundMessage(msg)).toBe("handled");
      expect(await handleInboundMessage(msg)).toBe("duplicate");
      const convo = await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(phone) }).lean();
      expect(JSON.parse(decryptPii(convo!.dataEncrypted)).contactName).toBe("Rohit Kumar");
    });

    it("processes simultaneous messages from one number in order and counts a double reply once", async () => {
      const phone = randomMobile("9");
      await say(phone, "REQUEST");
      await Promise.all([say(phone, "S. D."), say(phone, "skip")]);
      const data = JSON.parse(decryptPii((await WhatsAppConversation.findOne({ phoneLookup: phoneLookupToken(phone) }).lean())!.dataEncrypted));
      expect(data).toMatchObject({ patientName: "S. D.", patientAge: null });

      const donor = await registerOnWhatsApp("Quick Donor");
      const request = await createActiveRequest();
      await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(request) });
      await drain(fakeWhatsApp().provider);
      await Promise.all([say(donor.phone, "1"), say(donor.phone, "1")]);
      expect(await RequestResponse.countDocuments({ requestId: request._id })).toBe(1);
      expect((await EmergencyRequest.findById(request._id).lean())?.responseStats?.interested).toBe(1);
    });

    it("retries transient failures with backoff, then lets an admin retry only safe ones", async () => {
      const donor = await registerOnWhatsApp("Retry Donor");
      await drain(fakeWhatsApp().provider); // registration replies
      const request = await createActiveRequest();
      const queued = await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(request) });
      const messageId = queued.messageId!;

      const disconnected: MessagingProvider = { name: "whatsapp_web", isReady: () => true, sendText: async () => { throw new MessagingError("NOT_CONNECTED", true); } };
      let now = Date.now();
      for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
        await dispatchNext(disconnected, dispatchOptions(), new Date(now));
        now += 3 * 60 * 1000;
      }
      const failed = await NotificationEvent.findById(messageId).lean();
      expect(failed).toMatchObject({ status: "failed", failureCode: "NOT_CONNECTED", attempts: MAX_SEND_ATTEMPTS });

      await retryFailedAlert(messageId, admin, "t");
      expect((await NotificationEvent.findById(messageId).lean())?.status).toBe("queued");
      const { provider, sent } = fakeWhatsApp();
      await drain(provider);
      expect(sent.filter((m) => m.phone === donor.phone)).toHaveLength(1);

      // A possibly-delivered failure is never retried.
      await NotificationEvent.updateOne({ _id: messageId }, { $set: { status: "failed", failureCode: "SEND_TIMEOUT" } });
      await expectAppError(retryFailedAlert(messageId, admin, "t"), "NOT_RETRYABLE");
    });

    it("cancelled or fulfilled requests stop their alerts, and STOP blocks later alerts", async () => {
      const donor = await registerOnWhatsApp("Stop Donor");
      await drain(fakeWhatsApp().provider);
      const request = await createActiveRequest();
      await queueEmergencyRequestNotification({ requestId: request._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(request) });
      await adminUpdateStatus(request.publicRequestId, "cancelled", "Hospital arranged blood", admin, ctx);
      expect(await NotificationEvent.findOne({ requestId: request._id.toString(), kind: "emergency_request" }).lean()).toMatchObject({ status: "suppressed", failureCode: "REQUEST_CLOSED" });
      const { provider, sent } = fakeWhatsApp();
      await drain(provider);
      expect(sent.filter((m) => m.phone === donor.phone)).toHaveLength(0);

      // An alert already queued for a request that expires is suppressed at send time.
      const expiring = await createActiveRequest();
      await queueEmergencyRequestNotification({ requestId: expiring._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(expiring) });
      await EmergencyRequest.updateOne({ _id: expiring._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await drain(provider);
      expect((await NotificationEvent.findOne({ requestId: expiring._id.toString() }).lean())?.failureCode).toBe("REQUEST_NOT_ALERTABLE");

      await say(donor.phone, "STOP");
      const next = await createActiveRequest();
      const result = await queueEmergencyRequestNotification({ requestId: next._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(next) });
      expect(result).toMatchObject({ outcome: "suppressed", reason: "OPTED_OUT" });
    });

    it("caps alerts per donor per day and holds alerts while paused", async () => {
      const donor = await registerOnWhatsApp("Capped Donor");
      await drain(fakeWhatsApp().provider);
      const outcomes = [];
      for (let i = 0; i < 3; i++) {
        const r = await createActiveRequest();
        outcomes.push(await queueEmergencyRequestNotification({ requestId: r._id.toString(), donorUserId: donor.userId, summary: alertSummaryFor(r) }));
      }
      expect(outcomes.map((o) => o.outcome)).toEqual(["queued", "queued", "suppressed"]);
      expect(outcomes[2]).toMatchObject({ reason: "FREQUENCY_CAP" });

      const { provider, sent } = fakeWhatsApp();
      await drain(provider, { alertsPaused: true });
      expect(sent).toHaveLength(0);
      await drain(provider);
      expect(sent).toHaveLength(2);
    });

    it("with the bot switched off, only STOP is honoured", async () => {
      await updateMessagingSettings({ botEnabled: false }, admin, "t");
      const phone = randomMobile("9");
      expect(await say(phone, "REQUEST")).toBe("bot_disabled");
      expect(await repliesTo(phone)).toHaveLength(0);
      expect(await say(phone, "STOP")).toBe("opt_out");
      expect(await MessagingOptOut.exists({ phoneLookup: phoneLookupToken(phone) })).not.toBeNull();
      expect(await BotMetric.countDocuments()).toBeGreaterThan(0);
    });
  });
});
