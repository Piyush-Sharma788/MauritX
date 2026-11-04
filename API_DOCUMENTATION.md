# REST API DOCUMENTATION — v1

Base path: `/api/v1`

All request bodies must be validated with Zod. Return JSON. Use HTTPS only. Require `Idempotency-Key` for create operations that may be retried.

## Standard response
```json
{
  "data": {},
  "error": null,
  "meta": { "requestId": "opaque-correlation-id" }
}
```
Error response:
```json
{
  "data": null,
  "error": { "code": "VALIDATION_ERROR", "message": "Please check the submitted fields." },
  "meta": { "requestId": "opaque-correlation-id" }
}
```

## Authentication
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/otp/request` | Request OTP |
| POST | `/auth/otp/verify` | Verify OTP and issue session |
| POST | `/auth/logout` | Revoke current session |
| GET | `/auth/me` | Current authenticated user |

Example request:
```json
{ "phone": "+919876543210", "purpose": "donor_registration", "channel": "whatsapp" }
```
Do not reveal whether a phone number already has an account. Apply IP, phone and device rate limits.

## Donors
Donor **registration has no API**: it happens only in the WhatsApp bot (WHATSAPP_BOT.md §3), which creates the user and profile from the sender's normalized WhatsApp number. The endpoints below are for **profile access and management** after website sign-in (OTP to the same number). All require a session and act only on the caller's own records.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/donors/me` | Own overview: masked phone, profile (or `null`), and whether a WhatsApp registration is in progress |
| PATCH | `/donors/me` | Update `name`, `bloodGroup`, `city`, `locality`, `location` (`null` removes it), `lastDonationDate` (`null` clears it) |
| PATCH | `/donors/me/availability` | `{ "availableForRequests": boolean }` |
| POST | `/donors/me/consents` | `{ "action": "enable", "consent": true, "privacyNoticeVersion" }`, or `{ "action": "pause" \| "resume" \| "opt_out" }`. Opt-out is immediate |
| GET | `/donors/me/notifications` | Own recent emergency alerts (status and timestamps, never content) |
| POST | `/donors/me/phone/otp` | `{ "phone" }`: send a code to a new number |
| POST | `/donors/me/phone/verify` | `{ "phone", "code" }`: move the account to the new number. 409 `PHONE_IN_USE` if another account has it |
| DELETE | `/donors/me` | Start account deletion workflow (not implemented yet) |

Locations must be in India and are stored to about 1 km. Without a donor profile, profile endpoints return 404 `DONOR_NOT_REGISTERED`.

## Emergency requests
No account is needed. A tracking token, sent in the `X-Tracking-Token` header, authorises access to one request. Tokens arrive in a tracking URL (`/track/<token>`). A token for another request, a view-only token used to change something, or an unknown token all get the same `404`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/requests` | Create a request. Requires `Idempotency-Key`. `201`, or `200` with `replayed: true` on retry. `409 DUPLICATE_REQUEST` if the same phone, blood, hospital and city already has an open request. `429` when rate-limited (10 per IP per hour, 3 per phone per day) |
| GET | `/requests/:publicRequestId` | Tracking view: status, blood need, hospital, history (no notes), verification time. Never contains patient or contact details or coordinates. The manage scope adds the masked contact, allowed actions and family links |
| POST | `/requests/:publicRequestId/cancel` | Requester cancels (manage token) |
| POST | `/requests/:publicRequestId/status` | `{ "status": "partially_fulfilled" \| "fulfilled" \| "cancelled" }` (manage token). Requesters can never verify |
| POST | `/requests/:publicRequestId/share-links` | `{ "hours": 24 \| 72 \| 168 }`: create a view-only family link (manage token) |
| DELETE | `/requests/:publicRequestId/share-links/:linkId` | Revoke a family link (manage token) |
| GET | `/requests/:id/responses` | Read authorised responses (later phase) |

`410 TRACKING_LINK_EXPIRED` / `410 TRACKING_LINK_REVOKED` are returned for expired or turned-off links.

Create payload:
```json
{
  "patientName": "S. D.",
  "patientAge": 54,
  "contactName": "Rohit Kumar",
  "contactPhone": "+919876543210",
  "bloodGroup": "B+",
  "component": "packed_red_cells",
  "unitsRequested": 2,
  "requiredBy": "2026-11-04T12:00:00Z",
  "priority": "critical",
  "hospitalName": "Example Hospital",
  "hospitalAddress": "12 MG Road",
  "city": "Prayagraj",
  "locality": "Civil Lines",
  "hospitalPhone": null,
  "location": { "latitude": 25.4358, "longitude": 81.8463 },
  "whatsappUpdates": true,
  "consent": true,
  "privacyNoticeVersion": "2026-11-04"
}
```
The response includes `publicRequestId`, the private `manageUrl` (shown once) and `whatsappConfirmation` (`queued`, `not_requested`, `unavailable` or `suppressed`).

The example coordinates are illustrative only. Do not use a real patient's location in test fixtures.

### Admin: emergency requests
These require the `admin` role.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/admin/requests?q=&status=&bloodGroup=&city=&cursor=` | Real counts by status, plus a filtered, cursor-paginated list |
| GET | `/admin/requests/:publicRequestId` | Full details, including decrypted patient and contact data, notes and links. Each view is audit-logged |
| POST | `/admin/requests/:publicRequestId/status` | `{ "status", "note"? }`. Allowed transitions only (`409 INVALID_TRANSITION` otherwise) |
| DELETE | `/admin/requests/:publicRequestId/share-links/:linkId` | Turn off any tracking link |

### Admin: coordination (Phase 5)
All require the `admin` role, mutations must be same-origin, and every change is audit-logged.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/admin/requests/:id/coordination` | Alert counts by status, latest donor search, responses |
| POST | `/admin/requests/:id/matching` | `{ "radiusKm": 5 \| 10 \| 25 \| 50 }`. Runs a deterministic donor search and saves it. `201`. `409 INVALID_TRANSITION` unless the request is active or partially fulfilled |
| POST | `/admin/requests/:id/alerts` | `{ "matchingRunId" }`. Queues the next `ALERT_BATCH_SIZE` alerts in rank order (`202`). Errors: `409 ALERTS_PAUSED`, `ALERT_LIMIT_REACHED`, `MATCHING_REQUIRED` |
| POST | `/admin/requests/:id/institution` | `{ "institutionId": "<id>" \| null }`. Links a verified institution. `409 INSTITUTION_NOT_VERIFIED` otherwise |
| POST | `/admin/requests/:id/responses/:responseId/status` | `{ "status", "note"? }`. Moves a donor response forward one step. `409 INVALID_TRANSITION` |
| GET | `/admin/institutions` | List institutions |
| POST | `/admin/institutions` | `{ type, legalName, displayName, address, city, locality, publicPhone?, licenceReference? }`. Created as `pending`. `201` |
| GET | `/admin/institutions/:id` | Details, masked contacts, availability reports and linked open requests |
| POST | `/admin/institutions/:id/status` | `{ "verificationStatus": "pending" \| "verified" \| "rejected" \| "suspended", "note"? }` |
| POST | `/admin/institutions/:id/contacts` | `{ name, phone, role: "coordinator" \| "staff" }`. Added as `pending`. `409 PHONE_IN_USE` if the number already belongs to an institution |
| POST | `/admin/institutions/:id/contacts/:contactId` | `{ "status": "pending" \| "verified" \| "revoked" }` |
| GET | `/admin/operations` | Live counts: WhatsApp state, bot and AI counters, queue, coordination, institutions |
| PATCH | `/admin/operations/settings` | `{ "botEnabled"?, "alertsPaused"? }`. With the bot off, only STOP is processed |
| GET | `/admin/operations/failed-messages` | Recent failures (masked), each marked retryable or not |
| POST | `/admin/messages/:messageId/retry` | Re-queue a failed emergency alert that certainly wasn't delivered (`EXPIRED`, `NOT_CONNECTED`, `SEND_FAILED`, `PROVIDER_ACK_ERROR`) while its request is active. `409 NOT_RETRYABLE` otherwise |
| GET | `/admin/conversations?cursor=` | Conversation metadata: flow, step, status, masked number. No message content is stored. Each view is audit-logged |
| GET | `/admin/audit?action=&cursor=&limit=` | Audit events, newest first, cursor-paginated |

Donor phone numbers appear in responses only after that donor agreed to share them for that request.

## Responses
*Planned for the website. In Phase 5 donors respond on WhatsApp (WHATSAPP_BOT.md §10.3), and responses are managed through the admin endpoints above.*

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/requests/:id/responses` | Donor/institution response |
| POST | `/responses/:id/contact-consent` | Consent to share contact details |

## Institutions
*Planned for an institutional portal (Phase 6). In Phase 5 verified institutions use WhatsApp commands (WHATSAPP_BOT.md §10.6) and admins manage them through `/admin/institutions`.*

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/institutions/applications` | Apply for verification |
| GET | `/institutions/me` | Read institution profile |
| PATCH | `/institutions/me` | Update permitted fields |
| POST | `/institutions/:id/request-responses` | Respond to a request |

## Admin
Admin-only routes for verification, suspension, request review and audit access must live under `/admin/*` and enforce server-side RBAC plus audit logging. Do not expose admin operations to the client merely by hiding UI controls.

### Admin: WhatsApp Web pilot
All require a signed-in user with role `admin` (401 if signed out, 403 otherwise). Mutations require a same-origin request. Aliases exist at `/api/whatsapp/{status,qr,connect,logout,send-message}`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/admin/whatsapp/status` | Connection state (`disconnected`, `connecting`, `qr_required`, `connected`, `auth_failed`), `workerOnline`, masked linked account, last connect/disconnect, limits |
| GET | `/admin/whatsapp/qr` | Current pairing QR as SVG. 404 `WHATSAPP_QR_NOT_AVAILABLE` when not pairing. Never cached |
| POST | `/admin/whatsapp/connect` | `{ "restart": false }` starts or restores the client; `true` reconnects. 202 |
| POST | `/admin/whatsapp/logout` | Unlinks the device and deletes the saved session |
| POST | `/admin/whatsapp/send-message` | `{ "phone", "text" }` plus `Idempotency-Key` header. Queues one test message (202, or 200 on replay). Recipient must be in `WHATSAPP_WEB_TEST_RECIPIENTS` or a consented donor: otherwise 403 `RECIPIENT_NOT_ALLOWED`, or `RECIPIENT_OPTED_OUT` if the number has opted out |
| GET | `/admin/whatsapp/messages?limit=&cursor=` | Recent message log: masked recipients, status and timestamps, never message text |

503 `WHATSAPP_WORKER_UNAVAILABLE` means the worker process isn't running.

## WhatsApp webhooks
- `GET /webhooks/whatsapp`: provider webhook verification handshake.
- `POST /webhooks/whatsapp`: verify provider signature, validate event and process idempotently.
- Never trust a webhook solely because it contains a valid-looking JSON body.

## Status codes
- `200` success
- `201` created
- `202` accepted for asynchronous processing
- `400` malformed request
- `401` unauthenticated
- `403` authenticated but not authorised
- `404` not found (also use to avoid resource enumeration)
- `409` conflict / duplicate
- `410` gone (expired or revoked tracking link)
- `422` validation failure
- `429` rate limited
- `500` unexpected server error
- `503` temporary dependency outage

## API rules
- Use cursor pagination for lists.
- Apply field allow-lists; never pass request bodies directly into MongoDB updates.
- Use opaque IDs and avoid sequential public IDs.
- Do not return donor phone numbers or exact donor coordinates before explicit contact-sharing consent.
- Avoid putting sensitive data in URLs, analytics, logs or notification previews.
