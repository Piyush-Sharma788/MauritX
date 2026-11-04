# WHATSAPP BOT & NOTIFICATION DESIGN

## 1. Purpose
WhatsApp supports donor onboarding, OTP delivery (where approved and available), emergency alerts and simple donor responses. The web app remains the canonical place for full details and request management.

## 2. Official integration
Use the official WhatsApp Business Platform Cloud API. Obtain the required Meta business setup, phone-number registration, permissions and approved message templates. Follow current WhatsApp policies for opt-in, template categories, user-initiated conversations and messaging windows. Do not use unofficial WhatsApp Web automation or scrape contacts.

WhatsApp OTP delivery is not guaranteed to be available for every setup or region. Confirm authentication-template availability with Meta and implement an authorised SMS/voice fallback.

## 2a. Pilot exception: whatsapp-web.js (decided 2026-11-04)
For a controlled pilot, outbound donor messaging may use **whatsapp-web.js**, an unofficial WhatsApp Web client driven by Puppeteer/Chromium and linked to one WhatsApp number by QR code. This is a deliberate, time-boxed exception to §2. It is **not** the WhatsApp Business Platform and carries no Meta approval.

Risks accepted for the pilot:
- WhatsApp's terms prohibit unauthorised automated access. The linked number can be restricted or banned without notice or appeal.
- WhatsApp Web changes can break the library. There are no delivery guarantees, approved templates or official webhooks.
- The session files grant full access to the linked account.

Mandatory controls (implemented in `src/worker/whatsapp`, `src/server/messaging`):
- **Consent only.** Messages go only to donors with recorded, unwithdrawn WhatsApp consent, or to numbers in `WHATSAPP_WEB_TEST_RECIPIENTS`. Consent and the suppression list are re-checked immediately before every send.
- **No bulk or unsolicited messaging.** There is no broadcast feature.
  - *Decision (Phase 5, 2026-11-04):* emergency alerts are sent only in small batches that an admin triggers by hand. The request must be verified and active, and alerts go only to donors who opted in to alerts. See §10.
  - Batches are capped: `ALERT_BATCH_SIZE`, default 5; `ALERT_MAX_PER_REQUEST`, default 40; `ALERT_MAX_PER_DONOR_PER_DAY`, default 2.
  - Nothing is ever sent automatically.
  - All sends are also paced (`WHATSAPP_WEB_MIN_SEND_INTERVAL_MS`, default 4 s) and capped (`WHATSAPP_WEB_MAX_MESSAGES_PER_HOUR`, default 30). The cap is a safety limit, not a target.
- **STOP and HELP.** STOP is honoured immediately: the number is suppressed, consent is withdrawn, queued messages are cancelled and one confirmation is sent. HELP gets a single reply per day. No other inbound text is acted on or stored.
- **One session owner.** A single worker process owns the session, enforced by a MongoDB lease. A second worker refuses to start.
- **Admin-only pairing.** The QR code is shown only to administrators and only travels over a loopback, secret-authenticated channel. It is never logged or stored.
- **Protected session files.** `LocalAuth` session files live in `WHATSAPP_WEB_SESSION_DIR` (mode 0700, outside `public/` and `src/`), on an encrypted disk. Logout unlinks the device and deletes them.
- **No duplicates.** Every message has an idempotency key. A send interrupted by a crash is marked failed, never re-sent. Undelivered messages expire after `WHATSAPP_WEB_MESSAGE_TTL_MINUTES`.
- **Minimal retention.** Message text is encrypted at rest and erased once a message is sent, fails or is suppressed. Logs keep only status, timestamps and masked numbers.
- **OTP stays official.** Sign-in OTPs continue to use the official authentication-template flow (§6). They are never sent through the pilot.

Exit criteria: migrate outbound messaging to the official Cloud API before any public launch, or immediately if the pilot number is restricted. Migration means implementing the `MessagingProvider` interface (`src/server/messaging/provider.ts`) for the Cloud API and switching `ACTIVE_PROVIDER`. The queue, consent and dispatch logic don't change.

## 3. Donor registration conversation
**Decision (2026-11-04):** WhatsApp is the primary and complete donor registration channel. The website has no registration form: its "Become a Donor" button opens this chat (`https://wa.me/<WHATSAPP_WEB_PUBLIC_NUMBER>?text=REGISTER`). The donor's number is taken from the incoming message, and registering needs no website account.

```text
PRANEX: Welcome. We can help connect voluntary donors with nearby requests.
PRANEX: May we use this WhatsApp number for donor registration and alerts? Reply YES or NO.
User: YES
PRANEX: What name should we display? (You may use a preferred name.)
User: ...
PRANEX: Do you know your blood group? A+, A-, B+, B-, AB+, AB-, O+, O-, NOT SURE
User: ...
PRANEX: Select your city/locality or share approximate location.
User: ...
PRANEX: When was your most recent blood donation? You may select NOT SURE / PREFER NOT TO SAY.
User: ...
PRANEX: Alerts are optional. A blood centre will make the final eligibility decision. Confirm registration? YES / NO
```
Collect only what is needed. Do not ask for diagnoses, HIV status or other sensitive health details in a chat flow.

### Implemented flow
The flows are state machines in `src/server/conversations/onboarding-machine.ts`. Each state declares a prompt, a parser and the next state.

**Registration (`donor_onboarding`)**: `await_start → name → blood_group → city → locality → location (optional: share or SKIP) → last_donation (optional: date or SKIP) → availability → notification_consent → confirm`
- **Entry.** The website's Become a Donor button opens `wa.me/<WHATSAPP_WEB_PUBLIC_NUMBER>?text=REGISTER`. REGISTER, JOIN or START goes straight to the name. Any other first message gets the welcome question (YES/NO).
- **No number to type.** The donor's number is taken from the inbound message, normalized to E.164 (Indian mobiles only), and shown back to them ("We'll use this WhatsApp number …").
- **Commands at any step:** BACK (previous question), CANCEL (stop and delete answers), RESTART, HELP. STOP always wins.
- **Input handling.** Invalid answers get a specific hint and the same question again. Blood group accepts forms like "O+", "o positive" or "AB neg". Dates accept DD-MM-YYYY. Yes/no accepts common Hinglish ("haan", "nahi"). Locations are accepted only from India and coarsened to about 1 km.
- **Saved progress.** Progress is saved after every answer (encrypted). After a break of more than an hour, the bot greets with "Welcome back" and repeats the current question. Progress expires 30 days after the last message.
- **Consent.** Alerts are enabled only with an explicit YES at `notification_consent`, recorded in `consent_records`. The donor can register without alerts.
- **Saving.** On confirmation the profile is saved directly to MongoDB through the donor service. No website account is needed; the user record is keyed to the WhatsApp number.
- **No duplicates.** There is one user per normalized number, one profile per user and one conversation per number. REGISTER from a registered number returns their status instead.

**Update (`donor_update`)**: `update_menu → (1 name | 2 blood group | 3 city → locality | 4 location | 5 last donation | 6 availability | 7 emergency alerts)`
- It reuses the same questions and validation as registration and saves one change at a time.
- For alerts: YES turns them on (or resumes them) with a consent record; NO pauses them.
- BACK returns to the menu and CANCEL makes no changes.

**Commands** (outside a conversation; patient and institution commands are in §10):
- REGISTER (or JOIN, START)
- PROFILE (full details) and STATUS (availability and alerts). Before Phase 5, STATUS showed the full profile.
- UPDATE
- PAUSE / RESUME
- HELP
- STOP

STOP immediately adds the number to the suppression list, withdraws alert consent, suppresses queued messages, cancels any conversation and sends one confirmation. Opted-out numbers get no reply unless they send REGISTER, JOIN or START, which lifts the suppression; alert consent must still be given again (UPDATE → 7). Registered donors' other casual messages get the HELP menu at most once a day.

**Reliability.** Every inbound message ID is processed once. Messages from one number are processed in order, and the conversation uses optimistic locking. Each number is limited to 40 inbound messages an hour. Replies go through the outbox at priority 0.

**Website.** The website has no registration form. Donors sign in with an OTP to the same number to view and edit their profile, set availability and manage alerts. A signed-in user without a profile is sent to the WhatsApp chat.

## 4. Emergency alert template
Template: `emergency_alert_v2` (Phase 5, `src/server/messaging/templates.ts`). Replies come back in the chat, so there is no link.

```text
MARUTIX — EMERGENCY BLOOD ALERT

A patient requires {{bloodGroup}} blood.

Hospital: {{hospitalName}}
Location: {{locality}}, {{city}}
Component: {{component}}
Units required: {{units}}
Required by: {{requiredBy}} IST
Ref: {{publicRequestId}}

Can you help?

Reply:
1 — Interested
2 — Unavailable
3 — More information
4 — Stop alerts

Please coordinate with the hospital. Final donor eligibility and compatibility will be assessed by the blood centre.
```
- **Allowed content.** Every field is schema-constrained: a strict character set and length limits, and the reference must be a real request ID. Patient names, phone numbers and free text can't reach a broadcast.
- **Institutional fields only.** The hospital name and locality are institutional, not personal. There is never a patient name, requester number or medical detail.

## 4a. Request confirmation (Phase 4)
Template: `request_confirmation_v1`. It's sent only if the requester ticks "Send me a WhatsApp confirmation", WhatsApp is connected, and the number hasn't sent STOP. At most one is sent per request.
```text
MarutiX: your blood request {{publicRequestId}} has been received.
Status: Pending verification. Our team will verify it with the hospital.
Track it here: {{viewOnlyLink}}
MarutiX doesn't guarantee blood availability. Stay in touch with the hospital's blood centre, and call 112 in a life-threatening emergency.
Reply STOP to stop messages from MarutiX.
```
- **What it contains:** a view-only link, never the manage link, so a mistyped number can't be used to change the request. It never includes patient details.
- **Replies.** If the requester replies, the bot answers about their request instead of offering donor registration.

## 5. Donor responses
(Implemented in Phase 5; see §10.3.)
- `INTERESTED`: recorded, then the donor is asked separately whether their contact may be shared.
- `UNAVAILABLE`: record response and do not repeatedly alert for that request.
- `STOP`: immediately suppress future non-essential donor alerts and record opt-out.
- `HELP`: explain available commands and privacy controls.
- `REGISTER` (or `JOIN`, `START`): start registration, or show status if already registered.
- `STATUS`, `UPDATE`, `PAUSE`, `RESUME`: for registered donors.

Support interactive buttons where approved by the platform; always provide text fallback.

## 6. OTP flow
1. User requests OTP.
2. Backend generates a cryptographically secure, short-lived code.
3. Store only a keyed hash; set attempt and expiry limits.
4. Send through an approved authentication template/provider.
5. Verify using constant-time comparison where applicable.
6. Consume challenge once; create a secure session.
7. Apply per-number, IP and device throttling; detect abuse.
8. Never log, echo or store plaintext OTP.

## 7. Notification orchestration
- Match only donors who explicitly opted in and are active.
- Check donation interval policy and request state immediately before sending.
- Use wave-based notifications to avoid flooding.
- Deduplicate with a stable idempotency key.
- Respect frequency caps and quiet hours, except where a reviewed emergency policy permits otherwise.
- Handle delivery callbacks and retries.
- Stop queued notifications when the request closes.
- Provide an easy opt-out in every appropriate alert.

## 8. Webhook security
(Applies to the official Cloud API. The whatsapp-web.js pilot receives events over its own browser session instead; inbound content is still treated as untrusted, see §2a.)

- Verify Meta signature using the app secret and raw request body as documented by Meta.
- Validate event shape and phone-number/account identifiers.
- Store provider message IDs and process events idempotently.
- Reject replayed or invalid events.
- Respond quickly and move work to a queue.
- Never execute commands or database queries from untrusted message text.

## 9. Important limitations
A WhatsApp message saying “available” is not medical clearance. The donor must contact/attend a licensed blood centre, where identity, health, haemoglobin, screening and compatibility processes are handled by professionals.

## 10. Phase 5: conversation engine (implemented 2026-11-04)

One engine (`src/server/conversations/engine.ts`) handles every inbound message. It runs inside the existing worker, with no second WhatsApp client.

The inbound pipeline is unchanged:
1. Each provider message ID is processed once.
2. Each number is limited to 40 messages an hour.
3. STOP is handled first.
4. Messages from one number are processed in order.

Two admin switches apply on top of that:
- **Bot off.** Only STOP is processed; other messages are counted and dropped unanswered.
- **Alerts paused.** No emergency alert is queued or sent.

### 10.1 Routing order
1. **An active flow continues:**
   - emergency request;
   - cancellation;
   - alert reply (contact-sharing question);
   - donor registration or update.

   REQUEST interrupts any other flow, because an emergency outranks everything.
2. **Verified institution contacts:** REQUESTS, STATUS, ACK, AVAILABLE, FULFILLED, PARTIAL and HELP.
3. **Patients and families:** REQUEST (also "NEED BLOOD" or "EMERGENCY"), TRACK [MX-ID] and CANCEL [MX-ID].
4. **Alert replies:** 1–4, INTERESTED, AVAILABLE, UNAVAILABLE, MORE INFO. These count only when the number received an alert in the last 72 hours or names the request ID. Otherwise they fall through.
5. **Donor commands:** REGISTER, PROFILE (full details), STATUS (availability and alert preference), UPDATE, PAUSE, RESUME, HELP.
6. **Free text:** AI or keyword interpretation (§10.5). If nothing matches, the earlier donor-bot behaviour applies: the welcome question, now mentioning REQUEST, or the daily menu.

### 10.2 Emergency request on WhatsApp (`request-machine.ts`, a pure state machine)
**Fields**, in order:
1. Patient name or initials, and optional age.
2. Contact person and contact number. The number defaults to the sender's WhatsApp number (shown masked), so it isn't asked.
3. Blood group, or "not sure".
4. Component, and units (1–20).
5. Required by, in IST. Accepts "now", "in 3 hours", "today 6pm", "tomorrow 10am", "kal shaam" and "05-11-2026 14:30".
6. Urgency.
7. Hospital, city, locality and address.
8. An optional location pin.

**Behaviour:**
- Only unanswered fields are asked.
- Answers already known (the sender's number, a registered user's name, details stated in the first message) are marked with `*` in the summary for checking.
- Every answer is validated with the web form's schemas.
- BACK, RESTART, CANCEL and HELP work at every step.
- The summary is numbered: reply a number to change that field.
- Only an explicit YES submits, and the required-by time is re-checked at that moment.

**Saving:**
- The request is created through the same service as the web form: validation, duplicate detection, encryption, and status `pending_verification`.
- `createdVia: "whatsapp"` and `requesterPhoneLookup` record the sender.
- There is no IP on WhatsApp, so the rate limits are 3 requests per sender per day, plus the existing 3 per contact number.
- WhatsApp authenticates the sender, so the sender receives the private manage link. The idempotency key comes from the conversation, so a repeated YES can't create two requests.

**TRACK and CANCEL:**
- TRACK shows status only, never patient details, for requests this number created or is the contact for.
- CANCEL works only for open requests created on WhatsApp from the same number. It asks for YES first and withdraws any queued alerts. Web-created requests are cancelled with their manage link, so a mistyped contact number can't cancel someone else's request.

### 10.3 Alerts, responses and coordination
**Sending alerts** (admin only):
1. Find potential donors for an active request (`server/matching`, §10.4).
2. Send a batch: the next `ALERT_BATCH_SIZE` candidates, in rank order.

Each alert is deduplicated per (request, donor). These are re-checked when it is queued and again just before it is sent:
- the request is still active and not expired;
- the number isn't on the suppression list;
- consent is present and alerts aren't paused;
- the donor is available;
- the donor is under the daily cap.

Alerts expire after `ALERT_TTL_MINUTES`. Closing a request (fulfilled, cancelled or expired) withdraws its queued alerts at once.

**Donor replies:**
- **1 / INTERESTED.** Recorded once per (request, donor); a repeat is acknowledged, not counted. The donor is then asked separately whether their name and number may be shared with the coordinator and the hospital blood bank. YES or NO is recorded on the response. Verified coordinator contacts of a linked institution get a `coordinator_alert`; the donor's number is included only after YES.
- **2 / UNAVAILABLE.** Recorded and replaces any earlier interest. Their coordination becomes "not proceeding", and they aren't asked about that request again.
- **3 / MORE INFO.** Request status, hospital address, component, units and time. No patient data.
- **4.** The same as STOP.

**Coordination states** are kept separate from the reply:
- `interested` → `coordinator_contacted` → `hospital_coordination` → `donation_confirmed`, or `not_proceeding`.
- Only an admin or the institution moves a response forward. "Interested" is never shown as a donation.

### 10.4 Matching (deterministic, `server/matching/engine.ts`)
**Search area:**
- The admin chooses a radius of 5, 10, 25 or 50 km.
- Distance is measured from the linked institution's location, or from the requester's shared pin. Without either, the search falls back to the same city.
- Donors are fetched with a `2dsphere` `$geoWithin` query, plus same-city donors without coordinates.

**Exclusions**, each counted and shown to the admin:
- duplicates, and the requester themselves;
- inactive accounts, opted-out numbers, no alert consent, paused alerts, marked unavailable;
- unknown donor blood group, or a group outside the policy;
- a recent self-reported donation (`MATCH_MIN_DONATION_INTERVAL_DAYS`);
- outside the radius, or a different city without a location;
- already alerted or already replied.

**Ranking:** straight-line distance first, then same-city donors, with the same locality first.

**Blood group policy** (`policy.ts`):
- Exact ABO and Rh match only, until qualified medical professionals approve wider rules.
- The policy version and the review status `pending_clinical_review` are stored with every run and shown in the admin UI.
- A request with blood group "not sure" matches no one. Missing information is never treated as eligibility. The result is people to contact, not medically approved donors.

### 10.5 AI understanding (`src/server/ai`)
**Provider:**
- An abstraction (`AiProvider`). The implementation is `anthropic`, using Claude through the official SDK with schema-validated structured output and server-side refusal fallbacks.
- It is off by default (`AI_PROVIDER=none`). A deterministic keyword classifier is the fallback.

**Before a message is sent to the provider:**
- phone numbers are removed;
- the text is truncated to 500 characters;
- each number is rate-limited (`AI_MAX_CALLS_PER_NUMBER_PER_HOUR`).

**What the AI returns:** `intent`, `entities`, `confidence`, `missing_fields`, `requires_confirmation` and `suggested_response`. It is re-validated with a strict Zod schema; malformed or out-of-range output is rejected and counted. Calls, errors and rejections appear on the Operations page.

**What the AI may trigger:**
- Only read-only actions (TRACK, MORE INFO, HELP) and the start of a conversation (REQUEST, REGISTER, UPDATE, CANCEL), which still asks for confirmation.
- Extracted request details are kept only if they pass the same parsers and schemas as typed answers. They prefill the request and are marked for checking.
- Consent changes and responses are never made from an interpretation. "Please stop these" gets "Reply STOP to confirm".
- The AI never writes to the database, never matches donors, never sends notifications, and never verifies, cancels or confirms anything.
- An AI-written reply is forwarded only for unclear messages, only when it is short and makes no claim (no "submitted", "verified", "eligible", links or numbers), and always followed by the command list.

### 10.6 Institutions on WhatsApp
**Access:**
- A number has institutional access only while its `institution_contacts` record is verified *and* the institution is verified. Both are admin actions.
- Unverified numbers get a refusal for privileged commands, and the refusal is audit-logged. Revoking takes effect on the next message.
- STATUS, AVAILABLE and HELP keep their donor meaning for everyone else.

**Commands:**
- `REQUESTS`: open requests linked to the institution.
- `STATUS [MX-ID]`: response status for the institution or for one request.
- `ACK MX-ID`: acknowledge a request (recorded once, attributable).
- `AVAILABLE O+ PRBC 3`: a stock report. It is stored as a timestamped, attributed self-report, and shown only as such, never as confirmed stock.
- `FULFILLED / PARTIAL MX-ID`: coordinator role only. The request history records the actor as "institution", and further alerts stop.

### 10.7 Not implemented
- An institutional web portal (planned for Phase 6).
- Interactive WhatsApp buttons; replies are text.
- Template messages. The pilot can't use the official Business Platform or its templates.
- Automatic radius expansion or automatic waves.
