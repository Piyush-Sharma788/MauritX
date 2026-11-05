import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectToDatabase } from "@/lib/db/mongoose";
import { encryptPii, phoneLookupToken } from "@/lib/security/crypto";
import { DonorProfile } from "@/server/models/donor-profile";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { User } from "@/server/models/user";
import { createActiveRequest, randomMobile } from "./helpers/fixtures";

/**
 * Executes the real backup and restore drill (scripts/backup.sh, scripts/restore-test.sh)
 * against MongoDB: dump, checksum, optional encryption, restore into a scratch database,
 * and verification with the app's own decryption. Needs mongodump, mongorestore, mongosh
 * and openssl on PATH; skipped otherwise.
 */
const tools = ["mongodump", "mongorestore", "mongosh", "openssl"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);
const enabled = Boolean(process.env.MONGODB_URI_TEST) && tools;
const root = path.resolve(import.meta.dirname, "..");
const withDb = (uri: string, db: string) => uri.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);

function run(script: string, args: string[], env: Record<string, string | undefined>) {
  const result = spawnSync("bash", [path.join(root, "scripts", script), ...args], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

describe.skipIf(!enabled)("backup and restore drill (executed)", () => {
  const source = process.env.MONGODB_URI_TEST ?? "";
  const scratch = withDb(source, "marutix_restore_drill");
  const passphrase = randomBytes(32).toString("base64");
  let dir: string;

  beforeAll(async () => {
    await connectToDatabase();
    // Rows left by earlier runs were encrypted with other random test keys; the drill needs a clean source.
    await mongoose.connection.dropDatabase();
    await Promise.all([User.createIndexes(), DonorProfile.createIndexes(), EmergencyRequest.createIndexes()]);
    dir = mkdtempSync(path.join(tmpdir(), "marutix-backup-"));
    // Realistic data: encrypted phones with matching lookups, a donor profile and an open request.
    for (let i = 0; i < 5; i++) {
      const phone = randomMobile("7");
      const user = await User.create({ phoneLookup: phoneLookupToken(phone), phoneEncrypted: encryptPii(phone), phoneVerifiedAt: new Date(), displayName: `Backup Donor ${i}` });
      await DonorProfile.create({ userId: user._id, bloodGroup: "O+", city: "Pune", locality: "Kothrud", availableForRequests: true, registeredVia: "whatsapp", registeredAt: new Date() });
    }
    await createActiveRequest();
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await mongoose.connection.useDb("marutix_restore_drill").dropDatabase().catch(() => {});
  });

  it("backs up, restores into a scratch database and verifies counts, indexes and decryption", () => {
    const backup = run("backup.sh", [], { MONGODB_URI: source, BACKUP_DIR: dir });
    expect(backup.out).toContain("backup: ok");
    const files = readdirSync(dir).filter((f) => f.startsWith("marutix-"));
    expect(files.some((f) => f.endsWith(".archive.gz"))).toBe(true);
    expect(files.some((f) => f.endsWith(".sha256"))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(dir, files.find((f) => f.endsWith(".manifest.json"))!), "utf8"));
    expect(manifest.counts.users).toBeGreaterThanOrEqual(5);

    const restore = run("restore-test.sh", [], { RESTORE_TEST_URI: scratch, BACKUP_DIR: dir });
    expect(restore.out).toContain("RESTORE VERIFICATION PASSED");
    expect(restore.status).toBe(0);
    // The scratch copy is dropped afterwards.
    const left = execFileSync("mongosh", ["--nodb", "--quiet", "--eval", "print(connect(process.env.U).getCollectionNames().length)"], { env: { ...process.env, U: scratch }, encoding: "utf8" });
    expect(left.trim()).toBe("0");
  }, 180_000);

  it("encrypts the archive and restores it only with the right passphrase", () => {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(tmpdir(), "marutix-backup-"));
    const pass = path.join(dir, "passphrase");
    writeFileSync(pass, passphrase, { mode: 0o600 });
    const backup = run("backup.sh", [], { MONGODB_URI: source, BACKUP_DIR: dir, BACKUP_ENCRYPTION_PASSPHRASE_FILE: pass });
    expect(backup.out).toContain("backup: ok");
    const archive = readdirSync(dir).find((f) => f.endsWith(".archive.gz.enc"))!;
    expect(archive).toBeTruthy();
    expect(readdirSync(dir).some((f) => f.endsWith(".archive.gz"))).toBe(false);
    expect(readFileSync(path.join(dir, archive)).subarray(0, 8).toString()).toBe("Salted__");

    const wrong = path.join(dir, "wrong");
    writeFileSync(wrong, "not-the-passphrase-0123456789");
    const failed = run("restore-test.sh", [path.join(dir, archive)], { RESTORE_TEST_URI: scratch, BACKUP_ENCRYPTION_PASSPHRASE_FILE: wrong });
    expect(failed.status).not.toBe(0);

    const ok = run("restore-test.sh", [path.join(dir, archive)], { RESTORE_TEST_URI: scratch, BACKUP_ENCRYPTION_PASSPHRASE_FILE: pass });
    expect(ok.out).toContain("RESTORE VERIFICATION PASSED");
    expect(ok.status).toBe(0);
  }, 180_000);

  it("rejects a tampered archive, a restore over the source database, and the wrong PII key", () => {
    const archive = path.join(dir, readdirSync(dir).find((f) => f.endsWith(".archive.gz.enc"))!);
    const pass = path.join(dir, "passphrase");

    expect(run("restore-test.sh", [archive], { RESTORE_TEST_URI: source, BACKUP_ENCRYPTION_PASSPHRASE_FILE: pass }).out).toContain("refusing to restore");

    const wrongKey = run("restore-test.sh", [archive], { RESTORE_TEST_URI: scratch, BACKUP_ENCRYPTION_PASSPHRASE_FILE: pass, PII_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
    expect(wrongKey.status).toBe(1);
    expect(wrongKey.out).toContain("RESTORE VERIFICATION FAILED");

    const bytes = readFileSync(archive);
    bytes[bytes.length - 100] ^= 0xff;
    writeFileSync(archive, bytes);
    const tampered = run("restore-test.sh", [archive], { RESTORE_TEST_URI: scratch, BACKUP_ENCRYPTION_PASSPHRASE_FILE: pass });
    expect(tampered.status).toBe(1);
    expect(tampered.out).toContain("CHECKSUM MISMATCH");
  }, 180_000);
});
