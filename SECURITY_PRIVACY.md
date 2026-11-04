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
- Admin access must be least-privilege, MFA-protected where possible and fully audited.
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
- [ ] RBAC and resource ownership tests pass.
- [ ] OTP brute-force and enumeration tests pass.
- [ ] Webhook signature and replay tests pass.
- [ ] Donor contact/location privacy tests pass.
- [ ] Consent withdrawal and opt-out tested end-to-end.
- [ ] Share links expire and can be revoked.
- [ ] Logs redact personal data and secrets.
- [ ] Backup restore and incident response tested.
- [ ] Independent penetration test and legal/clinical review completed.
- [ ] whatsapp-web.js pilot retired or replaced by the official Cloud API before public launch (WHATSAPP_BOT.md §2a).
- [ ] Clinical review and approval of the donor matching policy (`policy.ts`).
- [ ] Legal review and DPA before enabling the AI provider with real users.
- [ ] Legal review of automated institutional email outreach; SMTP provider DPA; a real operator contact for OpenStreetMap services (or a self-hosted Overpass/Nominatim).
