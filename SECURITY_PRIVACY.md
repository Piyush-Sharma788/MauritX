# SECURITY & PRIVACY BASELINE

This is a minimum engineering baseline, not a legal opinion or a production security certification.

## 1. Data classification
- **High sensitivity:** patient/requester phone, precise patient location, donor phone, exact donor location, institution licence documents, authentication/session secrets.
- **Personal:** display name, locality, profile, response history.
- **Operational:** request IDs, delivery status, audit events and aggregate metrics.

Collect the minimum data necessary. Avoid patient names, diagnoses, government IDs and detailed medical history unless a reviewed legal/clinical need exists.
*Phase 4 decision:* emergency requests ask for the patient's "name or initials" (initials are suggested) and optional age, so the hospital can be verified. These are stored encrypted, visible only to admins (every view is audit-logged), and never shown on tracking links or in WhatsApp messages. No diagnosis or free-text medical notes are collected. This should be confirmed in the legal and clinical review.

## 2. Authentication
- Use short-lived OTP challenges, one-time consumption and strict attempt limits.
- Store OTP hashes, never plaintext codes.
- Use secure, HttpOnly, SameSite cookies for browser sessions; use CSRF protection where applicable.
- Rotate session identifiers after authentication and revoke on logout/account suspension.
- Keep access tokens and provider secrets server-side.
- Do not treat possession of a WhatsApp number as proof of clinical identity.

## 3. Authorization
- Implement server-side RBAC and resource-level checks.
- Requesters can access only their request or a valid, scoped share link.
- Donors can access and edit only their own profile and responses.
- Institution users can access only their institution's records.
- Admin access must be least-privilege, MFA-protected and fully audited. *(Implemented: coordinator/super_admin roles, mandatory TOTP, see §4 "Production safety sprint".)*
- Never rely on hidden buttons or client-side role checks.

## 4. Privacy and consent
- Present a clear privacy notice before collecting data.
- Record affirmative consent, purpose, notice version, channel and timestamp.
- Separate consent for donor alerts from consent to share a donor's contact with a requester.
- Explain location use and offer manual entry if location is denied. (Implemented: the location request is explained before the browser prompt, city and locality are always enough, and coordinates are stored to about 1 km.)
- Keep WhatsApp onboarding answers only while registration is in progress (encrypted, erased on completion or cancel, expired after 30 days of inactivity).
- Do not disclose donor phone numbers or exact coordinates without explicit consent.
- Make pause, opt-out, correction and deletion-request flows accessible.
- Use expiring, revocable share links with unguessable tokens. (Implemented:
  - 256-bit tokens, stored only as keyed hashes;
  - manage and view scopes;
  - expiry on every link, and revocation by the requester or an admin;
  - no-referrer and noindex headers on `/track/*`.)
- Set retention and deletion schedules, including backups, with qualified legal advice.

### Phase 5 privacy decisions
- **Contact sharing is its own consent.** A donor's "interested" reply doesn't share their contact. They are asked separately for this request. Only after YES do coordinators and verified institution contacts see their name and number. The answer is stored on the response.
- **Alerts carry no personal data.** They contain only the blood group, component, units, time, hospital, locality and request ID. Every field is schema-constrained.
- **Requesters see aggregate counts only.** TRACK shows the number of interested donors, never who they are.
- **AI processing is a separate, optional data flow** (`AI_PROVIDER=anthropic`).
  - What is sent: only free-text messages the bot couldn't match to a command, with phone numbers removed and truncated to 500 characters.
  - What is never sent: structured answers within a flow.
  - The AI's output is a proposal, validated deterministically. It can't change consent, data or request state.
  - Before enabling it in production, get legal review of sending user text to a third-party processor (DPDP Act), and sign a data-processing agreement.
- **Conversation logs** in the admin UI show flow and step metadata only. Message text is never stored.

### Phase 6 privacy and safety decisions
- **Contact sharing with the family.**
  - The donor's YES names everyone who may receive their first name, area and number for this request: the patient's family and one person they choose, the coordinator and the hospital blood bank.
  - A donor's number goes by WhatsApp only to a requester whose number WhatsApp authenticated (requests created on WhatsApp). Web requesters typed a number that may be wrong, so they get a nudge and see contacts behind their private link.
  - Each reveal, share link, link view and revocation is written to `contact_access_logs`.
  - Share links are scoped to donor contacts, expire within 72 hours (and never after the manage link), and can be revoked.
- **Institution data.**
  - Discovered records keep only contacts the source publishes, with source and time. They are never verified automatically.
  - Unreviewed discovered email addresses aren't used unless the operator opts in.
  - Outreach never contains patient names, requester numbers or medical details.
  - Every email can be stopped from its secure link, and permanent bounces mark the address invalid.
  - Institution answers are labelled "may be able to assist (stock not confirmed)".
- **Outbound requests.** Discovery and website enrichment fetch only public addresses on default ports, re-check redirects, honour robots.txt and limit size and time. OpenStreetMap data is publicly editable, so a URL in it is never trusted to be internal-safe.
- **Third-party services.** OpenStreetMap (Overpass, Nominatim) receives the search area and the hospital address for geocoding. That address is institutional, but get legal review before production. The SMTP provider receives the outreach emails.
- **Legal review needed before production:** institutional email outreach (unsolicited-communication rules) and the OpenStreetMap usage policy (identification, rate) or a self-hosted instance.

### Production hardening (2026-11-05)
- **Startup validation.** The web server (`src/instrumentation.ts`) and both workers refuse to start on invalid or unsafe configuration.
  - Production requires: HTTPS for `APP_BASE_URL`; secrets that aren't placeholders or low-diversity; distinct secrets; a random encryption key; and complete Cloud API settings, including the App Secret, when that provider is selected.
  - Empty `KEY=` lines count as unset.
- **Client IP for rate limits.** It's the `X-Forwarded-For` entry added by our own outermost proxy (`TRUSTED_PROXY_HOPS`, counted from the right), not the client-controlled left side.
- **Sessions:**
  - idle timeout: 72 h by default, 2 h for admins;
  - admin sessions end 12 h after sign-in;
  - every session ends on a role change, and on a phone change (except the session making the change);
  - revocations record a reason.
- **WhatsApp webhooks** are accepted only with a valid HMAC-SHA256 signature over the raw body.

### Production safety sprint (2026-11-05)

**Staff roles and RBAC.** The roles are `coordinator`, `super_admin`, and legacy `admin`, which is treated as `super_admin` until migrated. Permissions live in `src/lib/auth/permissions.ts`.

- **Every route is gated.** Each admin route handler calls `requireAdmin("<permission>")`, and each admin page calls `requireAdminPage(...)`. The check reads the role stored now, so a change applies on the next request. Hidden buttons are only cosmetic.
- **Coordinators can:**
  - verify and coordinate requests;
  - review discovered institutions;
  - see operations, read the WhatsApp status and log;
  - retry failed alerts and see conversations.
- **Only a super admin can:**
  - change bot and alert settings;
  - pair, connect or disconnect WhatsApp, and send test messages;
  - verify institutions and their WhatsApp staff contacts, which grants WhatsApp access;
  - retry dead jobs;
  - read the audit log and server error reports.
- **Role changes and MFA resets are CLI-only** (`npm run admin:grant|admin:revoke|admin:mfa-reset`). Each one is audit-logged and ends every session of that account.

**Mandatory 2FA for staff.** Staff use TOTP (RFC 6238: SHA-1, 30 s, 6 digits, ±1 step).

- **Gate.** Admin pages and APIs return `MFA_REQUIRED` until the current session has passed the second factor.
- **Storage.** The secret is encrypted with AES-256-GCM, like other PII. The ten recovery codes are kept only as HMAC hashes, are single-use, and are shown once.
- **Replay protection.** The last accepted time step is stored and updated atomically.
- **Attempt limits.** Every attempt counts (5 per 15 min and 20 per day per account; 20 per 15 min per IP). With three valid codes at any moment, this keeps the long-run guessing odds to about 6 in 100,000 per day.
- **Revoking access.** Removing staff access also deletes the authenticator.

**Account deletion.** Self-service from the dashboard. It requires a fresh OTP for the new purpose `account_deletion` (a login code doesn't work) plus typing DELETE. Staff must be demoted first.

| Data | What happens |
|---|---|
| Donor profile, WhatsApp conversation state, OTP challenges | Deleted |
| User record | Tombstone: status `deleted`, random lookup, placeholder ciphertext, no name, no MFA. The number can sign up again as a new account |
| Stored messages (`notification_events`) | Recipient number, body and template values erased. Queued messages are suppressed, and failed ones can't be retried |
| Alert consent | Withdrawn; a `withdrawn` consent record is appended |
| Responses on open requests | Set to `not_proceeding` (coordinators see the withdrawal). Contact sharing is withdrawn on all responses |
| Confirmed donations | Kept: they are part of the patient's record, with no contact sharing |
| Opt-out entry | Kept: a keyed hash, so the number is never alerted again |
| Consent history, audit and contact-access logs | Kept: they hold no personal data |
| Sessions | All revoked (`account_deleted`) |

Emergency requests are not tied to accounts. Instead, the jobs worker's hourly retention sweep anonymises them once they have been closed for `REQUEST_RETENTION_DAYS` (default 180).

- **Removed:** patient name and age, requester name and number, WhatsApp requester number, hospital phone, location, history and coordination notes, and institution response contacts.
- **Revoked:** share links.
- **Kept for reporting:** blood group, component, units, hospital, city, status timeline and counters.

**Error monitoring.** `reportError()` (`src/server/monitoring/report.ts`) is called from:

- the API wrapper (unhandled errors);
- Next.js `onRequestError` (render and server-action errors);
- dead jobs;
- the jobs and WhatsApp worker loops and fatal paths;
- the Cloud API webhook;
- final message-delivery failures.

What it does with each error:

- **Grouped, redacted record.** Errors are grouped by fingerprint into `error_events` (a count plus first and last seen; dropped 90 days after last seen) and shown to super admins on Operations.
- **Optional alerts** go to `ERROR_ALERT_WEBHOOK_URL`, at most once per kind every 30 minutes.
- **Redaction.** `redactText()` strips phone numbers, emails, 6-digit codes, bearer and `key=` secrets, and long opaque strings. The logger applies it to every string field.
- **Location** is recorded as the route file path or a shaped path (`/requests/track/:id`), never the raw URL.

**SMS fallback for OTPs** (optional, `SMS_PROVIDER=twilio`).

- **When it's used.** Codes go by SMS when the user asks ("Send by SMS instead") or automatically when WhatsApp delivery fails outright. It's still one challenge and one code.
- **Abuse limits.** SMS has its own limits on top of the OTP limits: 5 per IP per hour, `OTP_SMS_PER_PHONE_DAILY` (default 3), and a service-wide `OTP_SMS_DAILY_CAP` (default 500, which logs an error when reached). Only Indian mobile numbers are accepted, which removes international SMS-pumping targets.
- **DLT.** India requires a DLT-registered sender and an exact registered template; production startup warns about this.

**Backups.** `scripts/backup.sh`:

- runs `mongodump --gzip`, optionally with `--oplog`;
- can encrypt the archive with AES-256-CBC and PBKDF2 (600k iterations) from a passphrase file;
- writes a SHA-256 checksum and a manifest of collection counts;
- keeps the URI out of `argv`;
- refuses to back up an empty database;
- prunes archives after `BACKUP_RETENTION_DAYS`.

`scripts/restore-test.sh`:

- verifies the checksum, then decrypts;
- restores into a scratch database, refusing to restore over the source;
- checks counts against the manifest and that unique indexes exist;
- decrypts PII and recomputes phone lookups with the deployment's keys;
- then drops the scratch copy.

Limitations:

- `openssl enc` isn't authenticated encryption. The checksum detects corruption, so keep archives in versioned or object-locked storage to protect against tampering.
- Archives hold only ciphertext and hashes. They are useless without `PII_ENCRYPTION_KEY`, which must be escrowed separately, never next to the backups.

## 5. Application security
- Validate every request with a strict schema and size limits.
- Use parameterised/typed database operations; never accept raw MongoDB operators from clients.
- Escape untrusted content to prevent XSS.
- Apply CSRF protections, secure headers and a restrictive Content Security Policy.
- Rate-limit OTP, login, request creation, search, sharing and webhook endpoints.
- Prevent IDOR by checking ownership and relationship on every resource access.
- Use upload allow-lists, malware scanning and private object storage if documents are supported.
- Keep dependencies patched and run dependency, secret and static analysis scans.

## 6. Location security
- Request browser geolocation only after explaining its purpose.
- Store approximate donor coordinates where possible.
- Never expose a donor's exact coordinates in search results.
- Restrict patient location to matched recipients who need it and have been authorised.
- Do not put coordinates in analytics, public URLs or logs.
- Allow manual location entry and location refresh/deletion.

## 7. Infrastructure and operations
- Enforce TLS in transit and encryption at rest.
- Use a secret manager and separate development/staging/production credentials.
- Restrict database network access and use least-privilege database users.
- Enable backups, point-in-time recovery where available and routine restore drills.
- Centralise structured logs but redact personal data, OTPs and tokens.
- Monitor suspicious access, bulk lookups, notification spikes and repeated failed OTPs.
- Maintain incident response, breach assessment and notification procedures.

## 8. WhatsApp-specific controls
- Use official Meta APIs and approved templates.
- Obtain and record recipient opt-in.
- Verify webhook signatures and process events idempotently.
- Do not send patient details in message previews.
- Honour opt-out promptly and maintain suppression lists.
- Never use unofficial WhatsApp automation, **except** the documented, time-boxed whatsapp-web.js pilot (WHATSAPP_BOT.md §2a) with all of its controls in place: consent-only recipients, pacing and hourly caps, immediate STOP handling, admin-only QR pairing, a single session owner, and session files with mode 0700 on an encrypted disk.
- Treat WhatsApp Web session files as credentials: never serve, commit, log or back them up unencrypted.

## 9. Clinical and operational safeguards
- Donor interval filtering is only a conservative coordination aid, not medical clearance.
- India national blood-centre standards describe whole-blood intervals of 90 days for males and 120 days for females; final acceptance remains with the blood centre.
- Do not automatically determine blood compatibility from ABO/Rh alone. Crossmatching and clinical decisions belong to the licensed blood centre.
- Do not claim a blood unit is available unless the source is authorised, current and timestamped. *(Phase 5: institution stock reports are stored and shown as timestamped, attributed self-reports, never as confirmed stock.)*
- *(Phase 5)* The matching policy is exact ABO and Rh match, labelled `pending_clinical_review` (`src/server/matching/policy.ts`). Wider compatibility rules must be approved by qualified medical professionals before they're added. They must never be inferred by code or AI.
- *(Phase 5)* Institutional access requires a verified contact *and* a verified institution, both admin actions. A WhatsApp number alone grants nothing. Only coordinators can report fulfilment, and refusals are audit-logged.
- Provide an emergency disclaimer and direct users to their hospital/blood centre immediately.

## 10. India compliance workstream
- Obtain legal review for the Digital Personal Data Protection Act, 2023 and Digital Personal Data Protection Rules, 2025, including commencement, notices, consent, data-principal rights, security safeguards, retention and breach obligations applicable to the service.
- Obtain advice on applicable Drugs and Cosmetics Rules, blood-centre licensing, advertising/solicitation, health-sector obligations and state-specific requirements.
- Execute data-processing/vendor agreements with hosting, messaging and analytics providers.
- Define controller/data-fiduciary roles, grievance contact and deletion process.
- Do not claim compliance until counsel has reviewed actual implementation and operations.

## 11. Pre-launch security checklist
- [ ] Threat model completed.
- [x] RBAC and resource ownership tests pass. *(Admin RBAC + MFA: tests/sprint2-security.integration.test.ts.)*
- [ ] OTP brute-force and enumeration tests pass.
- [ ] Webhook signature and replay tests pass.
- [ ] Donor contact/location privacy tests pass.
- [ ] Consent withdrawal and opt-out tested end-to-end.
- [ ] Share links expire and can be revoked.
- [x] Logs redact personal data and secrets. *(Logger and error store redaction, tested; callers still must not log PII deliberately.)*
- [ ] Backup restore and incident response tested. *(Restore drill implemented and executed against local MongoDB, tests/backup-restore.integration.test.ts. Still to do: a drill against the production cluster, and an incident-response exercise.)*
- [ ] Every existing `admin` account moved to `coordinator` or `super_admin`, and every staff member enrolled in 2FA.
- [ ] DLT sender and template registered before `SMS_PROVIDER` is enabled.
- [ ] Independent penetration test and legal/clinical review completed.
- [ ] whatsapp-web.js pilot retired; Cloud API provider (WHATSAPP_BOT.md §12) tested with the real number, templates approved and `MESSAGING_PROVIDER=whatsapp_cloud`.
- [ ] Clinical review and approval of the donor matching policy (`policy.ts`).
- [ ] Legal review and DPA before enabling the AI provider with real users.
- [ ] Legal review of automated institutional email outreach; SMTP provider DPA; a real operator contact for OpenStreetMap services (or a self-hosted Overpass/Nominatim).
