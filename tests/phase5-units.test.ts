import { describe, expect, it } from "vitest";
import { parseComponent, parsePriority, parseRequiredBy, parseUnits } from "@/features/requests/parse";
import { classifyByKeywords, redactForAi, safeSuggestedReply } from "@/server/ai/interpret";
import { interpretationSchema } from "@/server/ai/schema";
import { validatedRequestEntities } from "@/server/conversations/engine";
import { advanceRequest, nextState, startRequest, type RequestSnapshot } from "@/server/conversations/request-machine";
import { parseAlertReply } from "@/server/coordination/responses";
import { allowedCoordination, canAdvanceCoordination } from "@/server/coordination/status";
import { parseAvailabilityLine } from "@/server/institutions/whatsapp";
import { haversineKm, matchDonors, type DonorRecord, type MatchRequest } from "@/server/matching/engine";
import { eligibleDonorGroups, MATCHING_POLICY } from "@/server/matching/policy";
import { canTransition } from "@/server/requests/status";

// 2026-11-04 10:00 IST
const NOW = new Date("2026-11-04T04:30:00Z");
const ist = (iso: string) => new Date(`${iso}+05:30`);

describe("required-by parsing (IST)", () => {
  it.each([
    ["now", NOW],
    ["ASAP", NOW],
    ["in 3 hours", new Date(NOW.getTime() + 3 * 3600_000)],
    ["2 hrs", new Date(NOW.getTime() + 2 * 3600_000)],
    ["today 6pm", ist("2026-11-04T18:00")],
    ["today 6.30 pm", ist("2026-11-04T18:30")],
    ["tonight", ist("2026-11-04T21:00")],
    ["tomorrow 10am", ist("2026-11-05T10:00")],
    ["tomorrow morning", ist("2026-11-05T09:00")],
    ["kal shaam", ist("2026-11-05T18:00")],
    ["18:00", ist("2026-11-04T18:00")],
    ["8 am", ist("2026-11-05T08:00")],
    ["05-11-2026 14:30", ist("2026-11-05T14:30")],
    ["5/11 2pm", ist("2026-11-05T14:00")],
    ["2026-11-06", ist("2026-11-06T09:00")],
  ])("%s", (text, expected) => {
    expect(parseRequiredBy(text, NOW)?.toISOString()).toBe(expected.toISOString());
  });

  it.each(["soon-ish", "31-02-2026", "6", "yesterday", ""])("rejects %j", (text) => {
    expect(parseRequiredBy(text, NOW)).toBeNull();
  });
});

describe("component, units and priority parsing", () => {
  it("reads common component names and menu numbers", () => {
    expect(parseComponent("PRBC")).toBe("packed_red_cells");
    expect(parseComponent("platelets")).toBe("platelets");
    expect(parseComponent("ffp")).toBe("plasma");
    expect(parseComponent("1")).toBe("whole_blood");
    expect(parseComponent("cake")).toBeNull();
  });
  it("accepts 1–20 units only", () => {
    expect(parseUnits("2 units")).toBe(2);
    expect(parseUnits("two")).toBe(2);
    expect(parseUnits("21")).toBeNull();
    expect(parseUnits("0")).toBeNull();
  });
  it("maps urgency words", () => {
    expect(parsePriority("1")).toBe("critical");
    expect(parsePriority("urgent")).toBe("urgent");
    expect(parsePriority("planned")).toBe("scheduled");
  });
});

describe("WhatsApp emergency request machine", () => {
  const ctx = { senderE164: "+919876543210", now: NOW };
  const text = (t: string) => ({ type: "text" as const, text: t });

  function run(snapshot: RequestSnapshot, answers: string[]) {
    let s = snapshot;
    for (const a of answers) {
      const out = advanceRequest(s, text(a), ctx);
      if (out.type !== "continue") return out;
      s = out.snapshot;
    }
    return { type: "continue" as const, snapshot: s, replies: [] };
  }

  it("skips what's already known, validates answers, and needs an explicit YES", () => {
    const { snapshot, replies } = startRequest("flow-1", { contactPhone: ctx.senderE164, bloodGroup: "O+", city: "Prayagraj" }, ctx);
    expect(replies.join("\n")).toMatch(/call 112/);
    expect(snapshot.state).toBe("patient_name");
    expect(snapshot.data.prefilled).toEqual(expect.arrayContaining(["contact_phone", "blood_group", "city"]));

    const mid = run(snapshot, ["S. D.", "skip", "Rohit Kumar", "2", "zero", "2", "today 6pm", "1", "City Hospital", "Civil Lines", "12 MG Road", "skip"]);
    expect(mid.type).toBe("continue");
    if (mid.type !== "continue") return;
    expect(mid.snapshot.state).toBe("confirm");
    expect(mid.snapshot.data).toMatchObject({ patientAge: null, unitsRequested: 2, component: "packed_red_cells", priority: "critical", location: null });

    // Anything but YES or a field number keeps the summary.
    const maybe = advanceRequest(mid.snapshot, text("ok cool"), ctx);
    expect(maybe.type === "continue" && maybe.snapshot.state).toBe("confirm");

    // Edit field 6 (component) from the summary, then return to it.
    const edit = advanceRequest(mid.snapshot, text("6"), ctx);
    expect(edit.type === "continue" && edit.snapshot.state).toBe("component");
    const edited = edit.type === "continue" ? advanceRequest(edit.snapshot, text("platelets"), ctx) : edit;
    expect(edited.type === "continue" && edited.snapshot.state).toBe("confirm");

    const done = edited.type === "continue" ? advanceRequest(edited.snapshot, text("YES"), ctx) : edited;
    expect(done.type).toBe("complete");
    if (done.type === "complete") expect(done.draft).toMatchObject({ component: "platelets", contactPhone: ctx.senderE164, hospitalName: "City Hospital" });
  });

  it("re-asks invalid answers with a hint and supports BACK and CANCEL", () => {
    const { snapshot } = startRequest("flow-2", { contactPhone: ctx.senderE164 }, ctx);
    const bad = advanceRequest(snapshot, text("!!"), ctx);
    expect(bad.type === "continue" && bad.snapshot.state).toBe("patient_name");
    const next = advanceRequest(snapshot, text("Asha"), ctx);
    if (next.type !== "continue") throw new Error("expected continue");
    const back = advanceRequest(next.snapshot, text("back"), ctx);
    expect(back.type === "continue" && back.snapshot.state).toBe("patient_name");
    expect(advanceRequest(next.snapshot, text("cancel"), ctx).type).toBe("cancelled");
  });

  it("changing the city clears the locality", () => {
    const { snapshot } = startRequest("flow-3", { contactPhone: ctx.senderE164 }, ctx);
    const s = run(snapshot, ["A", "40", "Ravi K", "B+", "1", "1", "now", "1", "District Hospital", "Lucknow", "Hazratganj", "Main road", "skip", "11", "Kanpur"]);
    expect(s.type === "continue" && s.snapshot.state).toBe("locality");
    expect(s.type === "continue" && s.snapshot.data.locality).toBeUndefined();
  });

  it("re-asks the time if it lapsed before confirmation", () => {
    const later = { ...ctx, now: new Date(NOW.getTime() + 3 * 24 * 3600_000) };
    const { snapshot } = startRequest("flow-4", { contactPhone: ctx.senderE164 }, ctx);
    const s = run(snapshot, ["A", "skip", "Ravi K", "B+", "1", "1", "now", "1", "District Hospital", "Lucknow", "Hazratganj", "Main road", "skip"]);
    if (s.type !== "continue") throw new Error("expected continue");
    const out = advanceRequest(s.snapshot, text("yes"), later);
    expect(out.type === "continue" && out.snapshot.state).toBe("required_by");
  });

  it("nextState walks fields in order", () => {
    expect(nextState({ flowId: "x" })).toBe("patient_name");
  });
});

describe("matching engine", () => {
  const request: MatchRequest = { bloodGroup: "B+", component: "packed_red_cells", location: { latitude: 25.44, longitude: 81.85 }, cityNormalized: "prayagraj", localityNormalized: "civil lines" };
  const donor = (id: string, overrides: Partial<DonorRecord> = {}): DonorRecord => ({
    userId: id,
    userStatus: "active",
    phoneLookup: `lookup-${id}`,
    bloodGroup: "B+",
    city: "Prayagraj",
    locality: "Civil Lines",
    location: { latitude: 25.45, longitude: 81.85 },
    availableForRequests: true,
    consentAt: new Date("2026-01-01"),
    consentWithdrawnAt: null,
    pausedAt: null,
    channels: ["whatsapp"],
    lastDonationDate: null,
    optedOut: false,
    alreadyContacted: false,
    ...overrides,
  });
  const options = { radiusKm: 10, now: NOW, minDonationIntervalDays: 90, maxCandidates: 50, requesterLookups: ["lookup-self"] };

  it("excludes every ineligible donor with an explainable reason, and ranks by distance", () => {
    const donors = [
      donor("far", { location: { latitude: 25.6, longitude: 81.85 } }), // ~18 km
      donor("near2", { location: { latitude: 25.47, longitude: 81.85 } }),
      donor("near1"),
      donor("nocoords", { location: null }),
      donor("othercity", { location: null, city: "Lucknow" }),
      donor("optout", { optedOut: true }),
      donor("noconsent", { consentAt: null }),
      donor("withdrawn", { consentWithdrawnAt: new Date() }),
      donor("paused", { pausedAt: new Date() }),
      donor("unavailable", { availableForRequests: false }),
      donor("unknown", { bloodGroup: "unknown" }),
      donor("mismatch", { bloodGroup: "O-" }),
      donor("recent", { lastDonationDate: new Date(NOW.getTime() - 30 * 24 * 3600_000) }),
      donor("contacted", { alreadyContacted: true }),
      donor("self", { phoneLookup: "lookup-self" }),
      donor("inactive", { userStatus: "suspended" }),
      donor("near1"),
    ];
    const result = matchDonors(request, donors, options);
    expect(result.candidates.map((c) => c.donorUserId)).toEqual(["near1", "near2", "nocoords"]);
    expect(result.candidates[0]).toMatchObject({ rank: 1, basis: "distance" });
    expect(result.candidates[2]).toMatchObject({ basis: "same_city", distanceKm: null });
    expect(result.candidates[0].reasons.join(" ")).toMatch(/straight line/);
    expect(result.excluded).toMatchObject({
      outside_radius: 1, different_city: 1, opted_out: 1, no_alert_consent: 2, alerts_paused: 1, not_available: 1,
      donor_blood_group_unknown: 1, blood_group_not_matched: 1, recent_donation: 1, already_contacted: 1, requester_self: 1, account_inactive: 1, duplicate: 1,
    });
    expect(result.scanned).toBe(donors.length);
  });

  it("is deterministic and respects the radius options", () => {
    const donors = [donor("b"), donor("a"), donor("far", { location: { latitude: 25.6, longitude: 81.85 } })];
    const a = matchDonors(request, donors, options);
    expect(matchDonors(request, [...donors].reverse(), options).candidates.map((c) => c.donorUserId)).toEqual(a.candidates.map((c) => c.donorUserId));
    expect(matchDonors(request, donors, { ...options, radiusKm: 25 }).candidates).toHaveLength(3);
    expect(matchDonors(request, donors, { ...options, radiusKm: 5 }).candidates).toHaveLength(2);
  });

  it("never matches a request whose blood group isn't known, and uses exact groups pending clinical review", () => {
    expect(matchDonors({ ...request, bloodGroup: "unknown" }, [donor("x")], options).candidates).toHaveLength(0);
    expect(eligibleDonorGroups("O-", "platelets")).toEqual(["O-"]);
    expect(MATCHING_POLICY.reviewStatus).toBe("pending_clinical_review");
  });

  it("falls back to same-city matching without request coordinates", () => {
    const result = matchDonors({ ...request, location: null }, [donor("x"), donor("y", { city: "Lucknow" })], options);
    expect(result.basis).toBe("city");
    expect(result.candidates.map((c) => c.donorUserId)).toEqual(["x"]);
  });

  it("measures straight-line distance", () => {
    expect(haversineKm({ latitude: 25.44, longitude: 81.85 }, { latitude: 25.45, longitude: 81.85 })).toBeCloseTo(1.11, 1);
  });
});

describe("coordination and lifecycle rules", () => {
  it("only moves interest forward step by step, and never back", () => {
    expect(canAdvanceCoordination("interested", "donation_confirmed")).toBe(false);
    expect(canAdvanceCoordination("hospital_coordination", "donation_confirmed")).toBe(true);
    expect(allowedCoordination("donation_confirmed")).toEqual([]);
    expect(allowedCoordination(null)).toEqual([]);
  });
  it("lets institutions report outcomes but never verify or cancel", () => {
    expect(canTransition("institution", "active", "fulfilled")).toBe(true);
    expect(canTransition("institution", "pending_verification", "verified")).toBe(false);
    expect(canTransition("institution", "active", "cancelled")).toBe(false);
  });
});

describe("alert and institutional reply parsing", () => {
  it("reads alert replies", () => {
    expect(parseAlertReply("1")).toBe("interested");
    expect(parseAlertReply("Interested MX-7K3Q9P2A")).toBe("interested");
    expect(parseAlertReply("2")).toBe("unavailable");
    expect(parseAlertReply("more info")).toBe("more_info");
    expect(parseAlertReply("4")).toBe("more_info");
    expect(parseAlertReply("3")).toBe("later");
    expect(parseAlertReply("contact me later")).toBe("later");
    expect(parseAlertReply("hello")).toBeNull();
  });
  it("reads availability lines", () => {
    expect(parseAvailabilityLine("AVAILABLE O+ PRBC 3")).toEqual({ bloodGroup: "O+", component: "packed_red_cells", units: 3 });
    expect(parseAvailabilityLine("available ab neg platelets none")).toEqual({ bloodGroup: "AB-", component: "platelets", units: 0 });
    expect(parseAvailabilityLine("AVAILABLE")).toBeNull();
    expect(parseAvailabilityLine("AVAILABLE unknown PRBC 3")).toBeNull();
  });
});

describe("AI safety helpers", () => {
  it("removes phone numbers before text leaves MarutiX", () => {
    expect(redactForAi("call me on +91 98765 43210 or 9876543210")).toBe("call me on [number] or [number]");
  });

  it("classifies the example messages without AI", () => {
    expect(classifyByKeywords("Need O positive blood urgently in Prayagraj.")).toMatchObject({
      intent: "create_request",
      entities: { bloodGroup: "O positive", city: "Prayagraj", requiredBy: "now" },
    });
    expect(classifyByKeywords("I want to register as a donor.").intent).toBe("register_donor");
    expect(classifyByKeywords("I can help with this request.").intent).toBe("donor_interested");
    expect(classifyByKeywords("Please stop sending me alerts.").intent).toBe("stop_messages");
    expect(classifyByKeywords("I need two units of platelets tomorrow.")).toMatchObject({ intent: "create_request", entities: { component: "platelets", requiredBy: "tomorrow" } });
    expect(classifyByKeywords("lol").intent).toBe("other");
  });

  it("keeps only entities that pass deterministic validation", () => {
    const known = validatedRequestEntities(
      { bloodGroup: "O positive", component: "platelets", units: 2, city: "Prayagraj", locality: "<script>", hospitalName: null, requiredBy: "tomorrow 10am", requestId: null },
      NOW,
    );
    expect(known).toEqual({ bloodGroup: "O+", component: "platelets", unitsRequested: 2, city: "Prayagraj", requiredBy: ist("2026-11-05T10:00").toISOString() });
    expect(validatedRequestEntities({ bloodGroup: "Q+", component: "soup", units: 2.5, city: null, locality: null, hospitalName: null, requiredBy: "whenever", requestId: null }, NOW)).toEqual({});
  });

  it("rejects malformed or out-of-range AI output", () => {
    const good = { intent: "help", entities: { bloodGroup: null, component: null, units: null, city: null, locality: null, hospitalName: null, requiredBy: null, requestId: null }, confidence: 0.9, missing_fields: [], requires_confirmation: false, suggested_response: "" };
    expect(interpretationSchema.safeParse(good).success).toBe(true);
    expect(interpretationSchema.safeParse({ ...good, intent: "delete_everything" }).success).toBe(false);
    expect(interpretationSchema.safeParse({ ...good, confidence: 7 }).success).toBe(false);
    expect(interpretationSchema.safeParse({ ...good, entities: { ...good.entities, units: 500 } }).success).toBe(false);
    expect(interpretationSchema.safeParse({ ...good, extra: true }).success).toBe(false);
  });

  it("never forwards an AI reply that claims an outcome", () => {
    const base = interpretationSchema.parse({ intent: "other", entities: { bloodGroup: null, component: null, units: null, city: null, locality: null, hospitalName: null, requiredBy: null, requestId: null }, confidence: 0.9, missing_fields: [], requires_confirmation: false, suggested_response: "" });
    expect(safeSuggestedReply({ ...base, suggested_response: "Could you tell me the city?" })).toBe("Could you tell me the city?");
    expect(safeSuggestedReply({ ...base, suggested_response: "Your request is submitted!" })).toBeNull();
    expect(safeSuggestedReply({ ...base, suggested_response: "You are eligible to donate." })).toBeNull();
    expect(safeSuggestedReply({ ...base, suggested_response: "See https://x.y" })).toBeNull();
  });
});
