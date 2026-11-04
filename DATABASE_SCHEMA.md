# DATABASE SCHEMA — MongoDB

Use MongoDB collections with schema validation at the application layer (Zod) and database indexes. Store UTC timestamps. Avoid storing full medical records.

## 1. `users`
```ts
{
  _id: ObjectId,
  phoneE164: string,            // unique, encrypted or tokenized where feasible
  phoneVerifiedAt: Date,
  role: "donor" | "institution_user" | "admin",
  status: "active" | "paused" | "suspended" | "deleted",
  displayName?: string,
  createdAt: Date,
  updatedAt: Date,
  deletedAt?: Date
}
```
Indexes: unique `phoneE164` (or deterministic lookup token), `role`, `status`.

## 2. `donor_profiles`
```ts
{
  _id: ObjectId,
  userId: ObjectId,             // unique
  bloodGroup: "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | "unknown",
  city: string,                 // required (max 60)
  locality: string,             // required (max 80)
  location?: { type: "Point", coordinates: [number, number] }, // coarsened to 2 decimals (~1 km)
  locationUpdatedAt?: Date,
  availableForRequests: boolean,
  notificationConsentAt?: Date,
  notificationConsentWithdrawnAt?: Date, // set by STOP / opt-out
  notificationsPausedAt?: Date,          // alerts paused (consent kept)
  notificationChannels: ["whatsapp"],
  lastDonationDate?: Date,
  lastDonationType?: "whole_blood" | "platelet" | "plasma" | "unknown", // not collected yet
  registeredVia: "whatsapp",   // registration happens only in the WhatsApp bot (enum keeps "web" for older records)
  registeredAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```
Indexes: unique `userId`, `location: "2dsphere"`, compound `{ bloodGroup: 1, availableForRequests: 1 }`.

Do not treat this profile as a clinical record or proof of eligibility. Last donation date is self-reported unless verified by a blood centre.
Profiles are created only by the WhatsApp bot, for the user whose `phoneLookup` matches the sender's normalized WhatsApp number. The unique `users.phoneLookup` and `donor_profiles.userId` indexes together guarantee one profile per number. The donor's name is stored on `users.displayName`, not duplicated here. Emergency alerts require consent that is present, not withdrawn and not paused, plus `availableForRequests`, and the number must not be on the suppression list.

## 3. `emergency_requests`
```ts
{
  _id: ObjectId,
  publicRequestId: string,      // "MX-" + 8 random Crockford base32 characters; non-sequential
  status: "pending_verification" | "verified" | "active" | "partially_fulfilled" | "fulfilled" | "cancelled" | "expired",
  priority: "critical" | "urgent" | "scheduled",
  patientNameEncrypted: string, // "name or initials", AES-256-GCM; admin-only
  patientAge?: number,
  contactNameEncrypted: string,
  contactPhoneEncrypted: string,
  contactPhoneLookup: string,   // keyed hash (rate limits, STOP checks, bot awareness)
  bloodGroup: "A+" | ... | "O-" | "unknown",
  component: "whole_blood" | "packed_red_cells" | "platelets" | "plasma" | "other",
  unitsRequested: number,       // 1–20
  requiredBy: Date,
  hospitalName: string,
  hospitalAddress: string,
  city: string, cityNormalized: string,
  locality: string,
  hospitalPhone?: string,
  location?: { type: "Point", coordinates: [lng, lat] }, // requester's device, ~100 m; NOT a verified hospital location
  verifiedAt?: Date, verifiedBy?: ObjectId,              // set only by an admin
  whatsappUpdates: boolean,
  consent: { sharingAcceptedAt: Date, privacyNoticeVersion: string },
  dedupeKey: string,            // keyed hash of phone + blood group + component + hospital + city
  history: [{ status, at, actor: "requester" | "admin" | "system", actorUserId?, note? }], // notes are admin-internal
  expiresAt: Date,
  closedAt?: Date,
  createdAt: Date,
  updatedAt: Date
}
```
Indexes:
- unique `publicRequestId`
- `{ status: 1, expiresAt: 1 }`, `{ createdAt: -1 }`
- `{ bloodGroup: 1, status: 1 }`, `{ cityNormalized: 1, status: 1 }`
- `{ dedupeKey: 1, createdAt: -1 }`, `{ contactPhoneLookup: 1, status: 1 }`
- `location: "2dsphere"` (sparse)

No TTL: requests are records. Free-text notes from requesters are deliberately not collected.

### `request_share_links`
`{ requestId, tokenHash (unique), scope: "manage" | "view", createdBy: "requester" | "admin" | "system", expiresAt, revokedAt?, createdAt }`
- **Tokens.** Each URL token is a random 256-bit value. Only its keyed hash is stored.
- **Manage links.** The requester's link: update or cancel the request. It expires 7 days after the request expires.
- **View links.** For family (24 hours, 3 days or 7 days), or sent in the WhatsApp confirmation. Read-only.
- **Revoking.** Any link can be revoked.

### `idempotency_records`
`{ key (unique), responseEncrypted, expiresAt (TTL 24h) }`: the encrypted response to a create call, replayed when the same `Idempotency-Key` is retried.

## 4. `institutions`
```ts
{
  _id: ObjectId,
  type: "blood_bank" | "hospital",
  legalName: string,
  displayName: string,
  address: string,
  location: { type: "Point", coordinates: [number, number] },
  publicPhone?: string,
  whatsappPhone?: string,
  verificationStatus: "pending" | "verified" | "rejected" | "suspended",
  licenceReference?: string,    // sensitive; access restricted
  verifiedAt?: Date,
  verifiedBy?: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```
Indexes: `location: "2dsphere"`, `{ type: 1, verificationStatus: 1 }`.

## 5. `request_responses`
```ts
{
  _id: ObjectId,
  requestId: ObjectId,
  responderUserId?: ObjectId,
  institutionId?: ObjectId,
  response: "interested" | "unavailable" | "contact_requested" | "fulfilled",
  contactSharingConsentAt?: Date,
  createdAt: Date,
  updatedAt: Date
}
```
Indexes: `{ requestId: 1, createdAt: -1 }`, unique compound key to prevent duplicate responses where appropriate.

## 6. `notification_events`
```ts
{
  _id: ObjectId,
  requestId?: ObjectId,
  recipientUserId?: ObjectId,
  institutionId?: ObjectId,
  channel: "whatsapp" | "sms",
  provider: "whatsapp_web" | "whatsapp_cloud",
  kind: "admin_test" | "donor_text" | "emergency_request" | "opt_out_confirmation" | "help_reply" | "bot_reply",
  templateName: string,
  priority: 0 | 1,                 // 0 = reply in a conversation the person started, 1 = proactive
  recipientLookup: string,         // keyed hash of the phone (suppression checks)
  recipientPhoneEncrypted: string, // AES-256-GCM
  bodyEncrypted?: string,          // erased once the message reaches a final state
  providerMessageId?: string,
  status: "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "suppressed",
  failureCode?: string,
  idempotencyKey: string,
  requestedBy?: ObjectId,
  attempts: number,
  nextAttemptAt: Date,
  lockedUntil?: Date,
  expiresAt: Date,                 // never sent after this
  sentAt?: Date, deliveredAt?: Date, readAt?: Date, failedAt?: Date,
  createdAt: Date,
  updatedAt: Date
}
```
Indexes: unique `idempotencyKey`, `{ providerMessageId: 1 }` (sparse), `{ status: 1, nextAttemptAt: 1, createdAt: 1 }`, `{ sentAt: -1 }`, `{ recipientLookup: 1, status: 1 }`.
This collection is also the outbox the WhatsApp worker drains.

## 7. `otp_challenges`
```ts
{
  _id: ObjectId,
  phoneLookup: string,          // keyed hash, not plaintext
  otpHash: string,              // never store plaintext OTP
  purpose: "login" | "registration" | "request_verification" | "phone_change",
  attempts: number,
  expiresAt: Date,
  consumedAt?: Date,
  createdAt: Date
}
```
Indexes: TTL on `expiresAt`, `{ phoneLookup: 1, createdAt: -1 }`.

## 7a. Supporting collections (added in implementation)
- `sessions`: `{ tokenHash (unique), userId, expiresAt (TTL), revokedAt }`. Server-side, revocable browser sessions.
- `rate_limits`: `{ key (unique keyed hash), count, expiresAt (TTL) }`. Fixed-window counters until Redis is provisioned.
- `messaging_opt_outs`: `{ phoneLookup, channel, source: "whatsapp_stop" | "user" | "admin", optedOutAt }`, unique on `{ phoneLookup, channel }`. The suppression list, which also covers numbers without accounts.
- `whatsapp_connection`: a single document (`_id: "primary"`) holding pilot connection state, masked linked account, last connect/disconnect, `leaseOwner`/`leaseExpiresAt` (single worker) and `heartbeatAt`. Never contains session credentials or QR codes.
- `users`: the phone is stored as `phoneLookup` (keyed token, unique) plus `phoneEncrypted`, in place of a plaintext `phoneE164`.
- `whatsapp_conversations`: `{ phoneLookup (unique), flow: "donor_onboarding" | "donor_update", status: "active" | "completed" | "cancelled", state, history: string[], dataEncrypted, userId?, startedVia: "whatsapp", lastInboundAt, completedAt?, cancelledAt?, expiresAt (TTL, 30 days after last activity), version }`. Saved bot progress. Answers are encrypted and erased once the conversation ends; `version` provides optimistic concurrency.
- `whatsapp_inbound_messages`: `{ providerMessageId (unique), receivedAt, expiresAt (TTL 14 days) }`. Guarantees each inbound message is processed once. No content is stored.

## 8. `consent_records` and `audit_logs`
Consent records (`consent_records`, append-only): `{ userId, purpose: "donor_alerts", channel: "whatsapp", action: "granted" | "paused" | "resumed" | "withdrawn", source: "web" | "whatsapp", noticeVersion, createdAt }`. Each event is a row, so a withdrawal is its own timestamped record. Index `{ userId: 1, createdAt: -1 }`.
Audit logs: actor, action, resource type/ID, timestamp, request correlation ID, outcome. Never log OTPs, access tokens, full phone numbers or patient notes.

## Data rules
- Encrypt sensitive fields at rest and in transit; use application-level encryption for especially sensitive identifiers.
- Keep exact location access restricted; do not return donor coordinates in public APIs.
- Set retention/deletion schedules with legal advice. TTL is not a substitute for a documented retention policy.
- Use backups with access control and tested deletion/retention handling.
- Do not store Aadhaar or full identity documents unless a reviewed legal/operational need exists.
