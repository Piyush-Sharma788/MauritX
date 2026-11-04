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
- **No bulk or unsolicited messaging.** There is no broadcast or wave feature. Sends are paced (`WHATSAPP_WEB_MIN_SEND_INTERVAL_MS`, default 4 s) and capped (`WHATSAPP_WEB_MAX_MESSAGES_PER_HOUR`, default 30). The cap is a safety limit, not a target.
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

**Commands** (outside a conversation):
- REGISTER (or JOIN, START)
- STATUS
- UPDATE
- PAUSE / RESUME
- HELP
- STOP

STOP immediately adds the number to the suppression list, withdraws alert consent, suppresses queued messages, cancels any conversation and sends one confirmation. Opted-out numbers get no reply unless they send REGISTER, JOIN or START, which lifts the suppression; alert consent must still be given again (UPDATE → 7). Registered donors' other casual messages get the HELP menu at most once a day.

**Reliability.** Every inbound message ID is processed once. Messages from one number are processed in order, and the conversation uses optimistic locking. Each number is limited to 40 inbound messages an hour. Replies go through the outbox at priority 0.

**Website.** The website has no registration form. Donors sign in with an OTP to the same number to view and edit their profile, set availability and manage alerts. A signed-in user without a profile is sent to the WhatsApp chat.

## 4. Emergency alert template (illustrative)
Template name: `pranex_donor_request_v1`

```text
PRANEX blood request near {{1}}.
Blood group: {{2}}
Component: {{3}}
Needed by: {{4}}
Can you consider helping? Open the secure link: {{5}}
Reply STOP to stop alerts.
```
Keep patient name and detailed medical information out of the message. The secure link must expire and show only the minimum necessary details.

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
- `INTERESTED`: open a secure page to review details and choose whether to share contact information.
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
