/**
 * Checks a restored MarutiX database (used by scripts/restore-test.sh):
 *
 *  1. every collection in the backup manifest exists with the same document count;
 *  2. unique indexes that protect data integrity were restored;
 *  3. PII decrypts with this deployment's PII_ENCRYPTION_KEY, and each user's keyed
 *     phone lookup matches their decrypted number (so sign-in would find them).
 *
 *   RESTORE_TEST_URI=mongodb://.../marutix_restore_test tsx scripts/verify-restore.ts manifest.json
 *
 * Prints counts and pass/fail only; never prints decrypted values.
 */
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import { decryptPii, phoneLookupToken } from "@/lib/security/crypto";

const REQUIRED_UNIQUE: [string, string][] = [
  ["users", "phoneLookup_1"],
  ["sessions", "tokenHash_1"],
  ["donor_profiles", "userId_1"],
  ["emergency_requests", "publicRequestId_1"],
  ["notification_events", "idempotencyKey_1"],
];
const SAMPLE = 200;

async function main() {
  const uri = process.env.RESTORE_TEST_URI;
  const manifestPath = process.argv[2];
  if (!uri || !manifestPath) throw new Error("Usage: RESTORE_TEST_URI=... verify-restore.ts <manifest.json>");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { database: string; counts: Record<string, number> };
  const failures: string[] = [];
  if (Object.keys(manifest.counts).length === 0) failures.push("the backup manifest lists no collections: the backup is empty");

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5_000 }).asPromise();
  const db = conn.db!;
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  let documents = 0;
  for (const [name, expected] of Object.entries(manifest.counts)) {
    if (!present.has(name)) {
      failures.push(`missing collection ${name}`);
      continue;
    }
    const actual = await db.collection(name).countDocuments({});
    documents += actual;
    if (actual === expected) continue;
    // MongoDB's TTL monitor may already have removed expired rows (OTPs, sessions, rate limits) after the restore.
    const ttl = (await db.collection(name).indexes()).some((i) => typeof i.expireAfterSeconds === "number");
    if (ttl && actual < expected) console.log(`note: ${name} has ${expected - actual} fewer documents (expired under its TTL index)`);
    else failures.push(`${name}: ${actual} documents, backup manifest says ${expected}`);
  }
  console.log(`collections: ${Object.keys(manifest.counts).length} in manifest, documents restored: ${documents}`);

  for (const [collection, index] of REQUIRED_UNIQUE) {
    if (!present.has(collection)) continue;
    const indexes = await db.collection(collection).indexes();
    if (!indexes.some((i) => i.name === index && i.unique)) failures.push(`${collection}: unique index ${index} missing`);
  }

  let users = 0;
  for await (const u of db.collection("users").find({ status: { $ne: "deleted" } }, { projection: { phoneEncrypted: 1, phoneLookup: 1 } }).limit(SAMPLE)) {
    users += 1;
    try {
      if (phoneLookupToken(decryptPii(u.phoneEncrypted as string)) !== u.phoneLookup) failures.push(`user ${u._id}: phone lookup doesn't match the decrypted number (different PII_ENCRYPTION_KEY?)`);
    } catch {
      failures.push(`user ${u._id}: phone doesn't decrypt (wrong PII_ENCRYPTION_KEY?)`);
    }
  }
  let requests = 0;
  for await (const r of db.collection("emergency_requests").find({}, { projection: { patientNameEncrypted: 1, contactPhoneEncrypted: 1 } }).limit(SAMPLE)) {
    requests += 1;
    try {
      decryptPii(r.patientNameEncrypted as string);
      decryptPii(r.contactPhoneEncrypted as string);
    } catch {
      failures.push(`request ${r._id}: details don't decrypt`);
    }
  }
  console.log(`decryption checked: ${users} users, ${requests} requests`);
  await conn.close();

  if (failures.length) {
    console.error(`RESTORE VERIFICATION FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("RESTORE VERIFICATION PASSED");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
