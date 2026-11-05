import { afterEach, describe, expect, it } from "vitest";
import { getDiscoveryConfig, resetDiscoveryConfigForTests } from "@/lib/discovery/config";
import { acceptExtraction, extractionSchema, extractWithAi, setContactExtractorForTests, type Extraction } from "@/server/discovery/ai-extract";
import { buildAreas, cellCenter } from "@/server/discovery/areas";
import { NoAvailabilitySource } from "@/server/discovery/availability";
import { capabilityFromOsm, dedupeDiscovered, duplicateReason, fromOsmElement, nameSimilarity, sharedContacts } from "@/server/discovery/normalize";
import { overpassQuery } from "@/server/discovery/openstreetmap";
import { checkEmailDomain, validatePhone } from "@/server/discovery/validate";
import { extractFromText, htmlToText, relevantText } from "@/server/discovery/website";

const P = { latitude: 25.4358, longitude: 81.8463 };
const north = (km: number) => ({ latitude: P.latitude + km / 111.32, longitude: P.longitude });

describe("duplicate detection", () => {
  it("scores names", () => {
    expect(nameSimilarity("City Hospital", "City Hospital Pvt Ltd")).toBe(1);
    expect(nameSimilarity("Swaroop Rani Nehru Hospital", "Swarup Rani Nehru Hospital")).toBeGreaterThan(0.8);
    expect(nameSimilarity("Apex Clinic", "Sangam Blood Centre")).toBeLessThan(0.3);
  });

  it("merges on a shared official contact nearby, not on chains' helplines or social pages", () => {
    const a = { name: "Kamla Nehru Memorial Hospital", ...P, type: "hospital" as const, channels: [{ type: "phone", value: "+915322466000" }] };
    expect(duplicateReason(a, { name: "KNM Hospital", ...north(0.05), type: "hospital", channels: [{ type: "phone", value: "+915322466000" }] })).toBe("shared_phone");
    // Far apart with an unrelated name: a shared number alone isn't enough.
    expect(duplicateReason(a, { name: "Phoenix Diagnostics", ...north(0.8), type: "hospital", channels: [{ type: "phone", value: "+915322466000" }] })).toBeNull();
    const tollFree = [{ type: "phone", value: "+9118001234567" }];
    expect(duplicateReason({ ...a, channels: tollFree }, { name: "Branch Hospital", ...north(0.05), type: "hospital", channels: tollFree })).toBeNull();
    expect(sharedContacts([{ type: "website", value: "https://www.facebook.com/x" }], [{ type: "website", value: "https://facebook.com/y" }])).toEqual([]);
    expect(sharedContacts([{ type: "website", value: "https://www.knmh.example/" }], [{ type: "website", value: "http://knmh.example/contact" }])).toEqual(["website:knmh.example"]);
  });

  it("never merges a hospital with a separate blood bank on the same campus, unless they share a source record", () => {
    const h = { name: "SRN Hospital", ...P, type: "hospital" as const, channels: [{ type: "phone", value: "+915322256507" }] };
    const bb = { name: "SRN Hospital Blood Bank", ...north(0.05), type: "blood_bank" as const, channels: [{ type: "phone", value: "+915322256507" }] };
    expect(duplicateReason(h, bb)).toBeNull();
    expect(duplicateReason({ ...h, refs: ["osm:node/1"] }, { ...bb, refs: ["osm:node/1"] })).toBe("same_source_record");
  });

  it("keeps every source ref and the opening hours when collapsing a result set", () => {
    const merged = dedupeDiscovered([
      fromOsmElement({ type: "way", id: 10, center: { lat: P.latitude, lon: P.longitude }, tags: { amenity: "hospital", name: "Life Care Hospital", phone: "9876500001" } })!,
      fromOsmElement({ type: "node", id: 11, lat: north(0.02).latitude, lon: P.longitude, tags: { amenity: "hospital", name: "Life Care Hospital", opening_hours: "24/7" } })!,
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].alsoRefs).toEqual(["osm:node/11"]);
    expect(merged[0].openingHours).toBe("24/7");
  });
});

describe("OSM tags", () => {
  it("reads blood capability from explicit blood tags and keeps opening hours", () => {
    expect(capabilityFromOsm({ amenity: "hospital", name: "General Hospital", "blood:whole": "yes" })?.capability).toBe("hospital_with_blood_bank");
    expect(capabilityFromOsm({ amenity: "clinic", name: "Lions Blood Bank" })?.capability).toBe("blood_bank");
    expect(capabilityFromOsm({ amenity: "clinic", name: "Skin Clinic" })).toBeNull();
    const item = fromOsmElement({ type: "node", id: 5, lat: 1, lon: 1, tags: { healthcare: "blood_donation", name: "Red Cross Blood Centre", opening_hours: "Mo-Sa 09:00-17:00" } })!;
    expect(item.openingHours).toBe("Mo-Sa 09:00-17:00");
    expect(overpassQuery(P, 10)).toContain('["name"~"blood",i]');
  });
});

describe("contact validation (no network)", () => {
  it("checks phone plausibility", () => {
    expect(validatePhone("+919876543210")).toEqual({ state: "valid", reason: "mobile_format" });
    expect(validatePhone("+915322256507").state).toBe("valid");
    expect(validatePhone("+910532225650").state).toBe("invalid");
    expect(validatePhone("+911111111111").state).toBe("invalid");
    expect(validatePhone("+14155550100").state).toBe("invalid");
  });
  it("never looks up reserved domains; .invalid is invalid", async () => {
    expect(await checkEmailDomain("bounce.example", 100)).toEqual({ state: "unknown", reason: "reserved_domain_not_checked" });
    expect(await checkEmailDomain("x.test", 100)).toMatchObject({ state: "unknown" });
    expect(await checkEmailDomain("nowhere.invalid", 100)).toMatchObject({ state: "invalid" });
  });
});

describe("website text", () => {
  const html = `<html><head><script>var x="admin@tracker.example"</script><style>.a{}</style></head><body>
    <h1>Welcome to Sunrise Hospital</h1><p>Our cardiology team ...</p><p>About us</p>
    <p>Blood Bank (24x7): Phone: 0532-2256 600</p><p>Email: bloodbank [at] sunrise [dot] example</p>
    <p>Dr. A. Sharma, cardiologist</p></body></html>`;
  it("extracts visible, labelled contacts and blood-bank mentions, without scripts", () => {
    const text = htmlToText(html);
    expect(text).not.toContain("tracker");
    const found = extractFromText(text);
    expect(found.emails).toEqual(["bloodbank@sunrise.example"]);
    expect(found.phones).toEqual(["+915322256600"]);
    expect(found.mentionsBloodBank).toMatch(/Blood Bank/);
  });
  it("keeps only contact-relevant lines, within the size limit", () => {
    const text = htmlToText(html);
    const relevant = relevantText(text, 500);
    expect(relevant).toContain("Phone: 0532-2256 600");
    expect(relevant).not.toContain("cardiology team");
    expect(relevantText(text, 30).length).toBeLessThanOrEqual(30);
  });
});

describe("AI extraction acceptance", () => {
  const text = "Blood Bank (24x7): Phone: 0532-2256 600\nEmail: bloodbank [at] sunrise [dot] example\nWe have a licensed blood bank on campus.";
  const base: Extraction = {
    emails: [{ value: "bloodbank@sunrise.example", purpose: "blood_bank", confidence: 0.9 }, { value: "ceo@sunrise.example", purpose: "general", confidence: 0.95 }],
    phones: [{ value: "0532 2256600", purpose: "blood_bank", confidence: 0.9 }, { value: "9999988888", purpose: "general", confidence: 0.9 }, { value: "0532 2256601", purpose: "general", confidence: 0.3 }],
    blood_bank: { status: "has_blood_bank", evidence: "We have a licensed blood bank on campus.", confidence: 0.9 },
    opening_hours: null,
  };
  it("accepts only values that literally appear in the text, above the confidence floor", () => {
    const accepted = acceptExtraction(base, text, 0.6);
    expect(accepted.emails.map((e) => e.value)).toEqual(["bloodbank@sunrise.example"]);
    expect(accepted.phones.map((p) => p.value)).toEqual(["+915322256600"]);
    expect(accepted.bloodBank).toMatchObject({ status: "has_blood_bank" });
    expect(accepted.rejected).toBe(3);
  });
  it("rejects invented evidence and malformed output", async () => {
    expect(acceptExtraction({ ...base, blood_bank: { status: "is_blood_bank", evidence: "State-of-the-art blood centre", confidence: 0.99 } }, text, 0.6).bloodBank).toBeNull();
    expect(extractionSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    setContactExtractorForTests({ name: "fake", extract: async () => ({ ...base, emails: [{ value: "x", purpose: "nope", confidence: 2 }] }) });
    expect(await extractWithAi({ institutionName: "Sunrise", pageUrl: "https://sunrise.example/", text }, 0.6)).toBeNull();
    setContactExtractorForTests({ name: "fake", extract: async () => { throw new Error("boom"); } });
    expect(await extractWithAi({ institutionName: "Sunrise", pageUrl: "https://sunrise.example/", text }, 0.6)).toBeNull();
    setContactExtractorForTests({ name: "fake", extract: async () => base });
    expect((await extractWithAi({ institutionName: "Sunrise", pageUrl: "https://sunrise.example/", text }, 0.6))?.emails).toHaveLength(1);
  });
  afterEach(() => setContactExtractorForTests(undefined));
});

describe("areas", () => {
  it("clusters counted cells and cities, requests first, and stores only cell centres", () => {
    const cellDeg = 10 / 111.32;
    const lat = Math.floor(P.latitude / cellDeg);
    const lng = Math.floor(P.longitude / cellDeg);
    const areas = buildAreas(
      [{ lat, lng, donors: 4, requests: 0 }, { lat, lng, donors: 0, requests: 1 }, { lat: lat + 5, lng, donors: 9, requests: 0 }],
      [{ city: "prayagraj", label: "Prayagraj", donors: 2, requests: 2 }],
      10,
      10,
    );
    // Weighted: requests count three times (9 donors > 2 donors + 2 requests > 4 donors + 1 request).
    expect(areas.map((a) => a.key)).toEqual([`cell:${lat + 5}:${lng}@10`, "city:prayagraj", `cell:${lat}:${lng}@10`]);
    expect(areas[2]).toMatchObject({ donorPoints: 4, requestPoints: 1, center: cellCenter(lat, lng, cellDeg) });
    expect(areas[1].center).toBeNull();
    expect(buildAreas([{ lat, lng, donors: 1, requests: 0 }], [], 10, 0)).toHaveLength(0);
  });
});

describe("configuration", () => {
  const keys = ["DISCOVERY_PROVIDER", "DISCOVERY_CONTACT_EMAIL", "DISCOVERY_CONTACT_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetDiscoveryConfigForTests();
  });
  it("accepts an identifying contact URL instead of an email, and requires one of them", () => {
    process.env.DISCOVERY_PROVIDER = "openstreetmap";
    delete process.env.DISCOVERY_CONTACT_EMAIL;
    process.env.DISCOVERY_CONTACT_URL = "https://marutix.example/about";
    resetDiscoveryConfigForTests();
    expect(getDiscoveryConfig().userAgent).toBe("MarutiX-EmergencyCoordination/1.0 (+https://marutix.example/about)");
    delete process.env.DISCOVERY_CONTACT_URL;
    resetDiscoveryConfigForTests();
    expect(() => getDiscoveryConfig()).toThrow(/DISCOVERY_CONTACT_EMAIL or DISCOVERY_CONTACT_URL/);
  });
  it("defaults are safe: no provider, area refresh only once a provider is set", () => {
    for (const k of keys) delete process.env[k];
    resetDiscoveryConfigForTests();
    expect(getDiscoveryConfig()).toMatchObject({ provider: "none", refreshMs: 14 * 24 * 60 * 60_000, areasPerRun: 3, requestDelayMs: 30_000 });
  });
});

describe("blood stock availability", () => {
  it("is unknown: there is no public live source", async () => {
    expect(await new NoAvailabilitySource().lookup()).toMatchObject({ status: "unknown", units: null, asOf: null });
  });
});
