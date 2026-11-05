/**
 * Real-data check of institution discovery against the public OpenStreetMap
 * services, written into a THROWAWAY database. Polite by construction: one
 * Overpass search, website reading for at most DISCOVERY_ENRICH_PER_RUN
 * site(s) (robots.txt + up to 2 pages), no website reachability GETs, so a
 * run makes about 4 external HTTP requests (plus DNS lookups for emails).
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/discovery-check.ts <lat> <lng> <radiusKm>
 *
 * Env overrides for this process only: DISCOVERY_PROVIDER=openstreetmap;
 * DISCOVERY_CONTACT_URL = this project's git remote (an identifying,
 * non-personal contact) unless a contact is already configured;
 * MONGODB_URI = DISCOVERY_CHECK_MONGODB_URI or
 * mongodb://127.0.0.1:27017/marutix_discovery_check (dropped at start).
 */
import { execFileSync } from "node:child_process";

const [latRaw, lngRaw, radiusRaw] = process.argv.slice(2);
const lat = Number(latRaw);
const lng = Number(lngRaw);
const radiusKm = Number(radiusRaw ?? "5");
if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(radiusKm > 0 && radiusKm <= 20)) {
  console.error("usage: discovery-check.ts <lat> <lng> <radiusKm (≤ 20)>");
  process.exit(2);
}

const dbUri = process.env.DISCOVERY_CHECK_MONGODB_URI ?? "mongodb://127.0.0.1:27017/marutix_discovery_check";
if (!/\/marutix_[a-z0-9_]*check[a-z0-9_]*$/i.test(dbUri)) {
  console.error("Refusing: the check database name must contain 'check' (it is dropped).");
  process.exit(2);
}
process.env.MONGODB_URI = dbUri;
process.env.DISCOVERY_PROVIDER = "openstreetmap";
if (!process.env.DISCOVERY_CONTACT_EMAIL && !process.env.DISCOVERY_CONTACT_URL) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim().replace(/\.git$/, "");
    if (/^https:\/\//.test(remote)) process.env.DISCOVERY_CONTACT_URL = remote;
  } catch {
    // no git remote
  }
}
process.env.DISCOVERY_AREA_RADIUS_KM = String(radiusKm);
process.env.DISCOVERY_ENRICH_PER_RUN ??= "1";
process.env.DISCOVERY_VALIDATE_WEBSITES = "false";
process.env.DISCOVERY_WEBSITE_TIMEOUT_MS ??= "8000";
process.env.DISCOVERY_WEBSITE_ENRICHMENT ??= "true";

const mask = (phone: string) => phone.replace(/^(\+91\d{3})\d{4}(\d{3})$/, "$1****$2");
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

async function main() {
  const mongoose = (await import("mongoose")).default;
  const { connectToDatabase } = await import("@/lib/db/mongoose");
  const { getDiscoveryConfig } = await import("@/lib/discovery/config");
  const { runAreaRefresh } = await import("@/server/discovery/areas");
  const { DiscoveryArea } = await import("@/server/models/institution-discovery-area");
  const { Institution } = await import("@/server/models/institution");

  const config = getDiscoveryConfig();
  console.log(`User-Agent: ${config.userAgent}`);
  console.log(`Overpass: ${config.overpassUrl}  database: ${dbUri.replace(/\/\/[^@]*@/, "//***@")}`);
  await connectToDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all([Institution.syncIndexes(), DiscoveryArea.syncIndexes()]);

  const key = `check:${lat.toFixed(4)},${lng.toFixed(4)}@${radiusKm}`;
  const now = new Date();
  await DiscoveryArea.create({ key, kind: "cell", center: { type: "Point", coordinates: [lng, lat] }, radiusKm, label: "discovery-check", derivedAt: now, nextRunAt: now });

  const started = Date.now();
  const result = await runAreaRefresh(key, now, { force: true });
  const area = await DiscoveryArea.findOne({ key }).lean();
  console.log(`\nResult (${((Date.now() - started) / 1000).toFixed(1)} s):`, JSON.stringify(result));
  if (result.status !== "done") {
    console.log(`Area error: ${area?.lastError ?? "unknown"}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const docs = await Institution.find({}).sort({ capability: 1, displayName: 1 }).lean();
  const live = docs.filter((d) => !d.mergedInto);
  console.log(`\n${live.length} institutions (${docs.length - live.length} merged away), ${docs.filter((d) => d.staleSince).length} stale\n`);
  console.log(`${pad("Name", 38)} ${pad("Capability (source)", 34)} ${pad("Phones", 32)} ${pad("Emails", 34)} ${pad("Website", 28)} ${pad("Hours", 14)} Status       Sources`);
  for (const d of live) {
    const ch = d.contactChannels ?? [];
    const phones = ch.filter((c) => c.type === "phone").map((c) => `${mask(c.value)}${c.source === "openstreetmap" ? "" : c.source === "ai_extracted" ? "(ai)" : "(web)"}${c.status === "invalid" ? "!" : ""}`);
    const emails = ch.filter((c) => c.type === "email").map((c) => `${c.value}${c.source === "openstreetmap" ? "" : c.source === "ai_extracted" ? "(ai)" : "(web)"}${c.status === "invalid" ? `!${c.validation?.reason ?? ""}` : c.validation?.state === "valid" ? "✓dns" : ""}`);
    const site = ch.find((c) => c.type === "website")?.value.replace(/^https?:\/\//, "") ?? "-";
    console.log(
      `${pad(d.displayName, 38)} ${pad(`${d.capability} (${d.capabilitySource})`, 34)} ${pad(phones.join(", ") || "-", 32)} ${pad(emails.join(", ") || "-", 34)} ${pad(site, 28)} ${pad(d.openingHours ?? "-", 14)} ${pad(d.verificationStatus === "verified" ? "verified" : "unverified", 12)} ${d.externalRefs.length}${d.externalRefs.length > 1 ? ` (merged: ${d.externalRefs.join(" + ")})` : ""}`,
    );
  }
  const count = (pred: (c: { type: string; source: string; status: string }) => boolean) => live.reduce((n, d) => n + (d.contactChannels ?? []).filter(pred).length, 0);
  console.log(`\nWith ≥1 phone: ${live.filter((d) => d.contactChannels.some((c) => c.type === "phone")).length}/${live.length}; with ≥1 email: ${live.filter((d) => d.contactChannels.some((c) => c.type === "email")).length}/${live.length}; with website: ${live.filter((d) => d.contactChannels.some((c) => c.type === "website")).length}/${live.length}; with opening hours: ${live.filter((d) => d.openingHours).length}/${live.length}`);
  console.log(`Capability: blood_bank ${live.filter((d) => d.capability === "blood_bank").length}, hospital_with_blood_bank ${live.filter((d) => d.capability === "hospital_with_blood_bank").length}, hospital ${live.filter((d) => d.capability === "hospital").length}`);
  console.log(`Contacts from websites: ${count((c) => c.source === "official_website")}, AI-extracted: ${count((c) => c.source === "ai_extracted")}, invalid after checks: ${count((c) => c.status === "invalid")}`);
  console.log(`Records with >1 source ref (duplicates merged): ${live.filter((d) => d.externalRefs.length > 1).length}; DB merges: ${result.merged}`);
  console.log("All records are unverified until an admin verifies them. Data © OpenStreetMap contributors (ODbL).");
  await mongoose.disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  process.exit(1);
});
