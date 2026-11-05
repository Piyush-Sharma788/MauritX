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

**Sprint 2 additions to `users`:**

- `role`: one of `donor | institution_user | coordinator | super_admin | admin`, where `admin` is legacy and means super_admin.
- `mfa`:
  - `secretEncrypted` and `pendingSecretEncrypted` (AES-256-GCM);
  - `enabledAt`;
  - `recoveryCodeHashes[]` (HMAC);
  - `lastUsedStep` (TOTP replay guard).
- After deletion: `status: "deleted"`, `deletedAt`, a `phoneLookup` of `deleted:<uuid>`, placeholder `phoneEncrypted`, and no `displayName` or `mfa`.

`sessions` additions:

- `mfaVerifiedAt`: when this session passed the second factor;
- `revokedReason` also takes `mfa_reset` and `account_deleted`.

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

*Phase 5 additions:*
- **Origin and sender.**
  - `createdVia: "web" | "whatsapp"`;
  - `requesterPhoneLookup?`, the keyed hash of the WhatsApp sender, which is the only number that can cancel a request through the bot.
- **Institution.**
  - `institutionId?`, the verified institution coordinating the request, linked by an admin;
  - `institutionAcknowledgedAt?` and `institutionAcknowledgedBy?`.
- **Counters.** `responseStats: { alertsQueued, interested, unavailable }`, updated atomically.
- **History.**
  - `history[].actor` may now be `"institution"`, with `actorContactId`;
  - a request created on WhatsApp gets the note "Created on WhatsApp".
- **Indexes.** `{ requesterPhoneLookup: 1, status: 1 }` and `{ institutionId: 1, status: 1 }`.

*Phase 6 additions:*
- **`requesterPhoneEncrypted?`.** The WhatsApp sender, the only requester number known to be genuine.
- **`geocodedLocation?`.** `{ Point, source: "openstreetmap", at }`, an approximate point from the hospital address.
- **`automation`.** `{ status: not_started | running | paused | cancelled | completed, startedAt?, changedAt?, changedBy?, donorPhase: pending | running | target_reached | exhausted | stopped, zoneIndex, waves[{ number, zoneIndex, zoneKm?, matchingRunId, queued, suppressed, at }], nextWaveAt?, discoveryStatus, discoveredAt? }`.
- **Counters.** `responseStats.later`.
- **Index.** `{ "automation.status": 1, status: 1 }`.

### `request_share_links`
`{ requestId, tokenHash (unique), scope: "manage" | "view" | "donor_contacts" (Phase 6), createdBy: "requester" | "admin" | "system", expiresAt, revokedAt?, createdAt }`
- **Tokens.** Each URL token is a random 256-bit value. Only its keyed hash is stored.
- **Manage links.** The requester's link: update or cancel the request. It expires 7 days after the request expires.
- **View links.** For family (24 hours, 3 days or 7 days), or sent in the WhatsApp confirmation. Read-only.
- **Revoking.** Any link can be revoked.

### `idempotency_records`
`{ key (unique), responseEncrypted, expiresAt (TTL 24h) }`: the encrypted response to a create call, replayed when the same `Idempotency-Key` is retried.

## 4. `institutions` (implemented in Phase 5)
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
Indexes: `location: "2dsphere"` (sparse), `{ type: 1, verificationStatus: 1 }`, `{ cityNormalized: 1, verificationStatus: 1 }`.

*As implemented:*
- `licenceReferenceEncrypted` (AES-256-GCM, admin-only) replaces `licenceReference`.
- Added fields: `city`, `cityNormalized`, `locality`, `statusNote` and `createdBy`.
- Contact numbers live in `institution_contacts` rather than `whatsappPhone`.

*Phase 6:*
- **Provenance.** `source: "admin" | "openstreetmap"` and `externalRefs[]` (for example `osm:node/123`; unique, used to deduplicate).
- **Capability.** `capability: "blood_bank" | "hospital_with_blood_bank" | "hospital"` and `capabilitySource: "admin" | "source_tags" | "name"`.
- **Contacts.** `contactChannels[]: { type: "email" | "phone" | "website", value, source: "openstreetmap" | "official_website" | "admin", sourceUrl?, retrievedAt, status: "unverified" | "verified" | "invalid" | "opted_out", statusChangedAt?, statusChangedBy? }`.
- **Review.** `review: { status: "unreviewed" | "approved" | "excluded", reviewedAt?, reviewedBy?, note? }`.
- **Seen in source.** `discoveredAt?` and `lastSeenAt?`.
- **Creator.** `createdBy` is now optional, since discovered records have no creator.
- **Defaults.** Discovered records start `pending` + `unreviewed`. Admin-added records start `approved`.

### `institution_contacts` (Phase 5)
`{ institutionId, nameEncrypted, phoneLookup (unique), phoneEncrypted, role: "coordinator" | "staff", status: "pending" | "verified" | "revoked", verifiedAt?, verifiedBy?, revokedAt?, createdBy }`
- **Access.** A number has institutional access on WhatsApp only while this record is `verified` *and* its institution is `verified`.
- **Roles.** Coordinators can also confirm fulfilment.
- **Numbers.** One institution per number.

### `institution_availability_reports` (Phase 5)
`{ institutionId, contactId, bloodGroup (known groups only), component, status: "available" | "unavailable", units?, source: "whatsapp", reportedAt }`.
- **Append-only.** Each row is a timestamped, attributed self-report.
- **Not confirmed stock.** Reports are never presented as confirmed or live stock.
- **Index.** `{ institutionId: 1, reportedAt: -1 }`.

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

*As implemented (Phase 5), for donor responses:*
`{ requestId, donorUserId, notificationId?, response: "interested" | "unavailable", contactSharingConsentAt?, contactSharingDeclinedAt?, coordinationStatus?: "interested" | "coordinator_contacted" | "hospital_coordination" | "donation_confirmed" | "not_proceeding", coordinationHistory: [{ status, at, actor: "donor" | "admin" | "institution", actorUserId?, actorContactId?, note? }], respondedAt }`
- **Indexes.** Unique `{ requestId: 1, donorUserId: 1 }`, plus `{ donorUserId: 1, createdAt: -1 }`.
- **States kept separate.**
  - "Notification sent" lives on `notification_events`.
  - The donor's reply is `response`.
  - What happened next is `coordinationStatus`.
- **Institutions.** Institution acknowledgements are on the request, and stock reports are in `institution_availability_reports`.

*Phase 6:* `response` also takes `"later"` ("contact me later"). There are also `requesterContactedAt?` (the requester says they contacted the donor) and `requesterNotifiedAt?`. `coordinationStatus` gains `"donor_arrived"`, between hospital coordination and donation confirmed.

### `institution_outreach` (Phase 6, InstitutionalOutreach + MessageDeliveryLog)
`{ requestId, institutionId (unique together), rank, distanceKm?, status, deliveries[], responseTokenHash?, responseTokenExpiresAt?, response?, followUp, discoveredAt }`
- **`status`:** `awaiting_review`, `no_contact`, `channel_unavailable`, `queued`, `sent`, `partially_sent`, `failed`, `excluded` or `cancelled`.
- **`deliveries[]`:** `{ channel: "email" | "whatsapp", target, contactChannelId?, notificationEventId?, status: queued | sending | sent | failed | suppressed, attempts, subject?, bodyEncrypted? (erased after sending), providerMessageId?, failureCode?, queuedAt, sentAt?, failedAt? }`.
- **`response`:** `{ status: can_assist | cannot_assist | need_info, at, source: secure_link | whatsapp | admin, contactNameEncrypted?, contactPhoneEncrypted?, note?, recordedBy? }`.
- **`followUp`:** `{ status: none | needed | done, at? }`.
- **Indexes.** `{ requestId, institutionId }` (unique), `{ requestId, rank }`, `{ institutionId, createdAt }`, `responseTokenHash` (unique, sparse).

### `jobs` (Phase 6)
`{ type: coordinate_request | discover_institutions | institution_outreach | send_outreach_email | donor_wave, key (unique), payload (IDs only), status: queued | running | succeeded | dead | cancelled, attempts, maxAttempts, runAt, lockedUntil?, lockedBy?, lastError?, finishedAt?, expiresAt? }`
- **Retention.** Succeeded jobs are deleted after 30 days through a TTL index. Dead jobs are kept until handled.

### `coordination_events` (Phase 6)
`{ requestId, type, summary, visibleToRequester, actor, actorUserId?, at }`
- **The request's coordination history.** Events marked visible are shown on the manage and family links, worded without donor or patient identities.

### `contact_access_logs` (Phase 6, ContactSharingLog)
`{ requestId, responseId?, donorUserId?, action: revealed | sent_by_whatsapp | share_link_created | share_link_viewed | share_link_revoked, via: manage_link | donor_contacts_link | whatsapp | admin, linkId?, actorUserId?, at }`
- **Append-only.** One row per disclosure. It never stores the contact itself.

### `matching_runs` (Phase 5)
`{ requestId, radiusKm, policyVersion, policyReviewStatus, basis: "distance" | "city", eligibleGroups, candidates: [{ donorUserId, rank, distanceKm?, basis, reasons[] }], excluded: { <reason>: count }, scanned, createdBy, createdAt }`
- **One explainable donor search.** Candidates hold user IDs only, never contact details.
- **Index.** `{ requestId: 1, createdAt: -1 }`.
- **Phase 6.** `trigger: "admin" | "automatic"`; `createdBy` is optional for automatic runs.

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

*Phase 5:*
- **New kind.** `kind` adds `"request_confirmation"` (Phase 4) and `"coordinator_alert"`.
- **New field.** `matchingRunId?` links an emergency alert to the search it came from.
- **New indexes.** `{ requestId: 1, kind: 1, status: 1 }` and `{ recipientLookup: 1, kind: 1, createdAt: -1 }`, used by the daily cap.
- **New suppression reasons:**
  - `REQUEST_NOT_ALERTABLE`: not active, closed or expired;
  - `REQUEST_CLOSED`: withdrawn when the request closed;
  - `FREQUENCY_CAP`;
  - `NOT_VERIFIED_INSTITUTION`.

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
- `whatsapp_conversations.flow` (Phase 5) also takes `"emergency_request"`, `"request_cancel"` and `"donor_response"`. There is still one conversation document per number: starting a flow replaces the previous one. Answers stay encrypted and are erased when a flow ends.
- `system_settings` (Phase 5): a single document, `_id: "messaging"`, holding `{ botEnabled, alertsPaused, updatedBy }`. These are admin switches; STOP is never affected.
- `bot_metrics` (Phase 5): `{ _id: "YYYY-MM-DD" (IST), counts: { inbound_processed, inbound_dropped_disabled, bot_errors, ai_calls, ai_errors, ai_rejected_output }, expiresAt (TTL 90 days) }`. Counts only, with no identifiers.
- `whatsapp_inbound_messages`: `{ providerMessageId (unique), receivedAt, expiresAt (TTL 14 days) }`. Guarantees each inbound message is processed once. No content is stored.

### `error_events` (Sprint 2)
One row per kind of unexpected server error.

- **Fields:** `fingerprint` (unique), `source` (`api | render | jobs | whatsapp_worker | whatsapp_webhook | messaging | coordination`), `event`, `errorName`, a redacted `message`, `where` (route file or shaped path, or job type), `count`, `firstSeenAt`, `lastSeenAt`, `lastRequestId`, and `alertedAt`.
- **Expiry:** a TTL deletes the row 90 days after `lastSeenAt`.
- **Contents:** no personal data.

### Sprint 2 field changes
- **`emergency_requests.anonymizedAt`:** set by the retention sweep. Index on `{ closedAt, anonymizedAt }`.
- **`otp_challenges`:**
  - `purpose` also takes `account_deletion`;
  - `deliveryChannel` is `whatsapp | sms | development`;
  - `providerMessageId` holds the Twilio SID for SMS.
- **`notification_events.recipientPhoneEncrypted`** is now optional: it's unset when the recipient deletes their account, and `recipientLookup` becomes `deleted:<userId>`.

## 8. `consent_records` and `audit_logs`
Consent records (`consent_records`, append-only): `{ userId, purpose: "donor_alerts", channel: "whatsapp", action: "granted" | "paused" | "resumed" | "withdrawn", source: "web" | "whatsapp", noticeVersion, createdAt }`. Each event is a row, so a withdrawal is its own timestamped record. Index `{ userId: 1, createdAt: -1 }`.
Audit logs: actor, action, resource type/ID, timestamp, request correlation ID, outcome. Never log OTPs, access tokens, full phone numbers or patient notes.

## Data rules
- Encrypt sensitive fields at rest and in transit; use application-level encryption for especially sensitive identifiers.
- Keep exact location access restricted; do not return donor coordinates in public APIs.
- Set retention/deletion schedules with legal advice. TTL is not a substitute for a documented retention policy.
- Use backups with access control and tested deletion/retention handling.
- Do not store Aadhaar or full identity documents unless a reviewed legal/operational need exists.
