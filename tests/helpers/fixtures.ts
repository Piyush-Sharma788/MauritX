import { randomInt, randomUUID } from "node:crypto";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { encryptPii, generatePublicRequestId, phoneLookupToken } from "@/lib/security/crypto";
import { EmergencyRequest, type EmergencyRequestDoc } from "@/server/models/emergency-request";

export const randomMobile = (prefix = "8") => `+91${prefix}${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

/** A request an admin has already verified and activated, inserted directly for alert tests. */
export async function createActiveRequest(overrides: Partial<EmergencyRequestDoc> = {}) {
  const now = new Date();
  const contactPhone = randomMobile("6");
  const doc = await EmergencyRequest.create({
    publicRequestId: generatePublicRequestId(),
    status: "active",
    priority: "critical",
    patientNameEncrypted: encryptPii("S. D."),
    contactNameEncrypted: encryptPii("Rohit Kumar"),
    contactPhoneEncrypted: encryptPii(contactPhone),
    contactPhoneLookup: phoneLookupToken(contactPhone),
    bloodGroup: "B+",
    component: "packed_red_cells",
    unitsRequested: 2,
    requiredBy: new Date(now.getTime() + 6 * 60 * 60 * 1000),
    hospitalName: "City Hospital",
    hospitalAddress: "12 MG Road",
    city: "Prayagraj",
    cityNormalized: "prayagraj",
    locality: "Civil Lines",
    whatsappUpdates: false,
    consent: { sharingAcceptedAt: now, privacyNoticeVersion: PRIVACY_NOTICE_VERSION },
    dedupeKey: randomUUID(),
    history: [
      { status: "pending_verification", at: now, actor: "requester" },
      { status: "verified", at: now, actor: "admin" },
      { status: "active", at: now, actor: "admin" },
    ],
    verifiedAt: now,
    expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
    ...overrides,
  });
  return doc.toObject();
}

export const alertSummaryFor = (r: { publicRequestId: string; requiredBy: Date }) => ({
  publicRequestId: r.publicRequestId,
  hospitalName: "City Hospital",
  locality: "Civil Lines",
  city: "Prayagraj",
  bloodGroup: "B+" as const,
  component: "packed_red_cells" as const,
  unitsRequested: 2,
  neededBy: r.requiredBy,
});
