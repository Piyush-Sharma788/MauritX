import { describe, expect, it } from "vitest";
import { interestTarget, planWave, zoneIndexFor, zoneLabel } from "@/server/coordination/zones";
import { capabilityFromOsm, dedupeDiscovered, fromOsmElement, normaliseEmail, normaliseIndianPhones, rankInstitutions } from "@/server/discovery/normalize";
import { overpassQuery } from "@/server/discovery/openstreetmap";
import { assertPublicUrl, UnsafeUrlError } from "@/server/discovery/safe-fetch";
import { extractContactLinks, robotsAllows } from "@/server/discovery/website";
import { emergencyRequestText } from "@/server/messaging/templates";
import { planOutreach, type PlanInput } from "@/server/outreach/plan";
import { outreachEmail, outreachWhatsApp } from "@/server/outreach/templates";

const ZONES = [5, 10, 25, 50];

describe("zone-wise donor waves", () => {
  const c = (id: string, rank: number, distanceKm: number | null) => ({ donorUserId: id, rank, distanceKm });

  it("assigns distances to zones, with a final same-city stage", () => {
    expect(zoneIndexFor(0.4, ZONES)).toBe(0);
    expect(zoneIndexFor(5, ZONES)).toBe(0);
    expect(zoneIndexFor(5.1, ZONES)).toBe(1);
    expect(zoneIndexFor(49, ZONES)).toBe(3);
    expect(zoneIndexFor(51, ZONES)).toBe(-1);
    expect(zoneIndexFor(null, ZONES)).toBe(4);
    expect(zoneLabel(1, ZONES)).toBe("5–10 km");
    expect(zoneLabel(4, ZONES)).toMatch(/same city/);
  });

  it("starts with the closest zone and expands only when it is empty", () => {
    const candidates = [c("far", 3, 30), c("mid", 2, 8), c("near", 1, 2), c("nocoords", 4, null)];
    expect(planWave(candidates, ZONES, 0, 5)).toMatchObject({ zoneIndex: 0, selected: [{ donorUserId: "near" }] });
    // Zone 0 done (the near donor was alerted and is no longer a candidate).
    expect(planWave(candidates.slice(0, 2), ZONES, 0, 5)).toMatchObject({ zoneIndex: 1, selected: [{ donorUserId: "mid" }] });
    expect(planWave([c("far", 3, 30)], ZONES, 1, 5)).toMatchObject({ zoneIndex: 3 });
    expect(planWave([c("nocoords", 4, null)], ZONES, 3, 5)).toMatchObject({ zoneIndex: 4 });
    expect(planWave([], ZONES, 2, 5)).toMatchObject({ exhausted: true, selected: [] });
  });

  it("never skips a newly eligible donor in an earlier zone, and respects the batch size", () => {
    const plan = planWave([c("new-near", 1, 1), c("z2a", 2, 7), c("z2b", 3, 9)], ZONES, 1, 2);
    expect(plan.selected.map((s) => s.donorUserId)).toEqual(["new-near", "z2a"]);
    expect(plan.remainingInZone).toBe(1);
  });

  it("targets twice the units unless configured", () => {
    expect(interestTarget(0, 1)).toBe(2);
    expect(interestTarget(0, 3)).toBe(6);
    expect(interestTarget(4, 3)).toBe(4);
  });
});

describe("OpenStreetMap normalisation", () => {
  it("recognises blood banks and blood-service hospitals only from explicit tags or the name", () => {
    expect(capabilityFromOsm({ healthcare: "blood_donation", name: "X" })).toMatchObject({ capability: "blood_bank", source: "source_tags" });
    expect(capabilityFromOsm({ amenity: "hospital", "healthcare:speciality": "general;transfusion" })).toMatchObject({ capability: "hospital_with_blood_bank" });
    expect(capabilityFromOsm({ amenity: "hospital", name: "District Hospital Blood Bank" })).toMatchObject({ capability: "hospital_with_blood_bank", source: "name" });
    expect(capabilityFromOsm({ amenity: "hospital", name: "Priti Hospital" })).toMatchObject({ capability: "hospital" });
    expect(capabilityFromOsm({ amenity: "pharmacy", name: "Med" })).toBeNull();
  });

  it("keeps only published contact values, normalised, with the source URL", () => {
    const item = fromOsmElement({
      type: "node",
      id: 6897674804,
      lat: 25.4442,
      lon: 81.8597,
      tags: { amenity: "hospital", name: "S.R.N. Hospital", phone: "0532 2256507; +91 532 2256508; +44 20 7946 0000", email: "Blood.Bank@srn.example", website: "srn.example", "addr:city": "Prayagraj" },
    })!;
    expect(item.externalRef).toBe("osm:node/6897674804");
    expect(item.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "phone", value: "+915322256507", source: "openstreetmap", sourceUrl: "https://www.openstreetmap.org/node/6897674804" }),
      expect.objectContaining({ type: "phone", value: "+915322256508" }),
      expect.objectContaining({ type: "email", value: "blood.bank@srn.example" }),
      expect.objectContaining({ type: "website", value: "https://srn.example/" }),
    ]));
    expect(item.channels.some((ch) => ch.value.includes("44"))).toBe(false); // non-Indian number dropped
    expect(fromOsmElement({ type: "node", id: 1, lat: 1, lon: 1, tags: { amenity: "hospital" } })).toBeNull(); // unnamed
  });

  it("merges the same place mapped twice and ranks blood banks first", () => {
    const base = { type: "way" as const, center: { lat: 25.4358, lon: 81.8463 } };
    const merged = dedupeDiscovered([
      fromOsmElement({ ...base, id: 1, tags: { amenity: "hospital", name: "City Hospital", phone: "9876543210" } })!,
      fromOsmElement({ type: "node", id: 2, lat: 25.4361, lon: 81.8464, tags: { amenity: "hospital", name: "City Hospital Pvt Ltd", email: "info@city.example" } })!,
      fromOsmElement({ type: "node", id: 3, lat: 25.6, lon: 81.8, tags: { amenity: "hospital", name: "City Hospital" } })!,
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].channels.map((ch) => ch.type).sort()).toEqual(["email", "phone"]);
    const ranked = rankInstitutions([
      { id: "h-near", capability: "hospital" as const, distanceKm: 1 },
      { id: "bb-far", capability: "blood_bank" as const, distanceKm: 9 },
      { id: "hb", capability: "hospital_with_blood_bank" as const, distanceKm: 4 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["bb-far", "hb", "h-near"]);
  });

  it("normalises phones and emails strictly", () => {
    expect(normaliseIndianPhones("+91-98765 43210")).toEqual(["+919876543210"]);
    expect(normaliseIndianPhones("12345")).toEqual([]);
    expect(normaliseEmail("mailto:Info@Hosp.example?subject=hi")).toBe("info@hosp.example");
    expect(normaliseEmail("not an email")).toBeNull();
    expect(normaliseEmail('"x" <a@b.example>')).toBeNull();
  });

  it("builds a bounded Overpass query", () => {
    const q = overpassQuery({ latitude: 25.4, longitude: 81.8 }, 80);
    // Capped at 50 km: about ±0.449° of latitude.
    expect(q).toContain("(24.95084,");
    expect(q).toContain('"healthcare"~"^(blood_donation|blood_bank|hospital)$"');
    expect(q).toContain("[timeout:50]");
  });
});

describe("official website contacts", () => {
  it("honours robots.txt for our agent and *", () => {
    const robots = "User-agent: *\nDisallow: /private\nAllow: /private/contact\n\nUser-agent: BadBot\nDisallow: /";
    expect(robotsAllows(robots, "/")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/contact")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /", "/contact")).toBe(false);
    expect(robotsAllows("User-agent: MarutiX\nDisallow: /\n\nUser-agent: *\nAllow: /", "/")).toBe(false);
    expect(robotsAllows("", "/anything")).toBe(true);
  });

  it("reads only explicit mailto/tel links, and contact pages on the same host", () => {
    const html = `<a href="mailto:bloodbank@hosp.example">Mail</a><a href="tel:+91 532 2256507">Call</a>
      <a href="/contact-us">Contact</a><a href="https://evil.example/contact">x</a> write to admin@hidden.example`;
    const found = extractContactLinks(html, "https://hosp.example/");
    expect(found.emails).toEqual(["bloodbank@hosp.example"]);
    expect(found.phones).toEqual(["+915322256507"]);
    expect(found.contactPages).toEqual(["https://hosp.example/contact-us"]);
  });
});

describe("outbound URL safety (SSRF)", () => {
  it.each(["http://127.0.0.1:3100/health", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1/", "http://[::1]/", "ftp://example.com/", "http://8.8.8.8:8080/", "http://user:pw@8.8.8.8/"])("refuses %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });
  it("allows a public address on a default port", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/")).resolves.toBeInstanceOf(URL);
  });
});

describe("outreach planning", () => {
  const base: PlanInput = { verificationStatus: "pending", reviewStatus: "unreviewed", channels: [], verifiedWhatsAppContacts: 0, emailConfigured: true, includeUnreviewed: false };
  const email = (status: "unverified" | "verified" | "invalid" | "opted_out") => ({ id: "e1", type: "email" as const, value: "bb@h.example", status });

  it("waits for review before using an unverified, discovered address", () => {
    expect(planOutreach({ ...base, channels: [email("unverified")] }).status).toBe("awaiting_review");
    expect(planOutreach({ ...base, reviewStatus: "approved", channels: [email("unverified")] })).toMatchObject({ status: "queued", emails: [{ value: "bb@h.example" }] });
    expect(planOutreach({ ...base, includeUnreviewed: true, channels: [email("unverified")] }).status).toBe("queued");
    expect(planOutreach({ ...base, channels: [email("verified")] }).status).toBe("queued");
  });

  it("never uses excluded institutions or invalid / opted-out addresses", () => {
    expect(planOutreach({ ...base, reviewStatus: "excluded", channels: [email("verified")] }).status).toBe("excluded");
    expect(planOutreach({ ...base, verificationStatus: "suspended", channels: [email("verified")] }).status).toBe("excluded");
    expect(planOutreach({ ...base, reviewStatus: "approved", channels: [email("invalid"), email("opted_out")] }).status).toBe("no_contact");
  });

  it("is honest when email isn't configured, and uses WhatsApp only for verified institutions", () => {
    expect(planOutreach({ ...base, emailConfigured: false, channels: [email("verified")] }).status).toBe("channel_unavailable");
    expect(planOutreach({ ...base, verifiedWhatsAppContacts: 2 }).status).toBe("no_contact");
    expect(planOutreach({ ...base, verificationStatus: "verified", verifiedWhatsAppContacts: 2 })).toMatchObject({ status: "queued", whatsapp: true, emails: [] });
  });
});

describe("message content", () => {
  const neededBy = new Date("2026-11-05T06:30:00Z");
  it("donor alerts show approximate distance and the reply options, never patient data", () => {
    const text = emergencyRequestText({ publicRequestId: "MX-7K3Q9P2A", hospitalName: "City Hospital", locality: "Civil Lines", city: "Prayagraj", bloodGroup: "B+", component: "whole_blood", unitsRequested: 2, neededBy, distanceKm: 3.4 });
    expect(text).toMatch(/URGENT BLOOD REQUEST[\s\S]*Blood group: B\+[\s\S]*Distance: approximately 3 km \(straight line\)[\s\S]*1 — I am interested[\s\S]*3 — Contact me later/);
    expect(emergencyRequestText({ publicRequestId: "MX-7K3Q9P2A", hospitalName: "City Hospital", locality: "Civil Lines", city: "Prayagraj", bloodGroup: "B+", component: "whole_blood", unitsRequested: 2, neededBy })).not.toMatch(/Distance/);
  });

  it("institution outreach carries the request, a secure link and the coordinator, but no patient data", () => {
    const summary = { publicRequestId: "MX-7K3Q9P2A", bloodGroup: "B+" as const, component: "whole_blood" as const, unitsRequested: 2, hospitalName: "City Hospital", locality: "Civil Lines", city: "Prayagraj", requiredBy: neededBy, priority: "critical" as const, verified: true, respondUrl: "http://localhost:3000/respond/abc", coordinatorPhone: "+91 532 000 0000", coordinatorEmail: null };
    const mail = outreachEmail(summary, "Sangam Blood Centre");
    expect(mail.subject).toContain("MX-7K3Q9P2A");
    expect(mail.text).toMatch(/Blood group: B\+[\s\S]*Units required: 2[\s\S]*Priority: Critical[\s\S]*http:\/\/localhost:3000\/respond\/abc[\s\S]*MarutiX coordinator: \+91 532 000 0000/);
    expect(mail.text).toMatch(/nothing in this message confirms availability/);
    expect(outreachWhatsApp(summary)).toMatch(/Reply ASSIST MX-7K3Q9P2A or UNABLE MX-7K3Q9P2A/);
  });
});
