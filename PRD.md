# PRD — Product Requirements Document

## 1. Product summary
PRANEX is a mobile-first coordination platform that helps a patient or family member create a blood request and connect with nearby opted-in donors, verified blood banks and verified hospitals.

## 2. Users and roles
- **Requester:** patient, relative or caregiver creating a request. No account required for MVP.
- **Donor:** individual with a verified phone number, donor profile and notification preferences.
- **Blood bank:** verified institution account that can receive requests and update its own contact/availability information.
- **Hospital:** verified institution account that can receive and respond to requests.
- **Admin/moderator:** verifies institutions, handles reports, abuse and operational issues.

## 3. Primary user journeys

### A. Requester creates an emergency
**Implemented:**
- **Phase 4:** steps 1–5 and 9, with human verification.
- **Phase 5:**
  - the whole journey can also run in WhatsApp (REQUEST, TRACK, CANCEL);
  - step 7 runs as admin-triggered, small, consent-checked alert batches to matched donors;
  - step 8 is coordinated by MarutiX admins and verified institutions. The requester sees aggregate response counts, and donor contacts are shared only with coordinators, after the donor's consent.
- **Not yet built:** the requester-facing list of nearby results and the route ETA in step 6.

1. Open PRANEX and choose **Emergency** (the homepage "Request Blood" button).
2. Explain location permission and ask for consent. Offer manual location/hospital search if permission is denied.
3. Enter patient/request details: blood group (including “unknown”), component, units, hospital, required-by time, city/area and requester contact.
4. Verify requester phone with OTP if required for abuse prevention; do not force a patient account. *Decision (Phase 4): no requester OTP, to keep the flow fast. Abuse is controlled by human verification (every request starts as Pending verification), per-IP and per-phone rate limits, and duplicate detection. Patient details are limited to "name or initials" and optional age, encrypted and visible only to admins.*
5. Confirm consent to share the minimum necessary request information with relevant recipients.
6. Create request and show nearby results with distance and, where available, estimated travel time.
7. Notify a limited, relevant donor cohort and verified institutions.
8. Show responses and let the requester/family contact a consenting responder.
9. Close/cancel request when fulfilled or no longer needed.

### B. Donor registers through WhatsApp (decided 2026-11-04)
Donor registration happens **entirely in the MarutiX WhatsApp bot**. There is no website registration form, and registering doesn't require a website account.
1. Donor taps **Become a Donor** on the website, which opens the MarutiX WhatsApp chat with "REGISTER" pre-filled, or messages the number directly. The donor's WhatsApp number is captured from the incoming message and never typed.
2. Bot asks for name or preferred display name, blood group (or "not sure"), city and locality, optional location, availability, and explicit consent for emergency alerts.
3. Bot asks last donation date only if the donor chooses to provide it. Do not ask for unnecessary diagnoses or sensitive medical history.
4. Explain that the answers are not a medical eligibility assessment.
5. Donor confirms profile. The completed profile is saved to MongoDB, keyed to the normalized WhatsApp number, so one number can only have one profile.
6. In WhatsApp the donor can send STATUS, UPDATE, PAUSE, RESUME, STOP or HELP. STOP immediately disables all future notifications.
7. The website is for **profile access and management only**. The donor signs in through a separate phone-verification (OTP) flow to view and edit the profile, change availability and manage alerts.

### C. Donor receives a request
*Phase 5:*
- **Selection.** Donors are selected by the deterministic matching engine, using an exact-group policy pending clinical review, distance, opt-in and the recorded donation interval.
- **Alert and replies.** The alert is a WhatsApp message with reply options: Interested, Unavailable, More info, Stop. It has no link.
- **Interested donors.** An interested donor is asked separately whether their contact can be shared.
1. System selects donors using blood group/component rules configured with clinical advice, distance, opt-in status and recorded donation interval.
2. Send a WhatsApp template message with a minimal summary and secure response link.
3. Donor chooses **Interested**, **Unavailable** or **Stop alerts**.
4. Interested donor sees next steps and can choose to share contact details with the requester.
5. The blood centre performs its own screening and compatibility testing.

### D. Institution responds
*Phase 5:*
- Admins verify institutions and their contacts.
- Verified contacts use WhatsApp commands: REQUESTS, STATUS, ACK, AVAILABLE, and FULFILLED / PARTIAL (FULFILLED and PARTIAL are for coordinators).
- The secure portal is Phase 6.
1. Institution account is approved by admin after licence/identity verification.
2. Institution receives a request notification.
3. An authorised staff member opens the secure portal and responds with availability/contact instructions.
4. Stock or service information must show source and last-updated time. Never present stale data as live.

## 4. Functional requirements

### Authentication and profiles
- Donor registration is verified by the WhatsApp number the donor messages from. OTP verification is used for website sign-in (donor dashboard) and institutional accounts.
- WhatsApp OTP is subject to Meta product availability, approved authentication templates and platform policy. Provide SMS/voice fallback through an authorised provider.
- Session rotation, logout and account recovery.
- Donor can edit blood group, approximate location, contact preferences and availability.
- Donor can pause alerts, opt out and request profile deletion.

### Emergency requests
- No mandatory patient account.
- Validate required fields and phone number.
- Support blood group unknown; allow components to be configured (whole blood, packed red cells, platelets, plasma) with clinical review.
- Request status (decided in Phase 4, replacing the earlier draft list): `pending_verification` → `verified` → `active` → `partially_fulfilled` → `fulfilled`, plus `cancelled` and `expired`.
  - Only an admin can verify, after confirming with the hospital.
  - Nothing is ever marked verified or fulfilled automatically.
  - Requesters can cancel, or report fulfilled or partially fulfilled.
  - Open requests expire automatically 24 hours after the required-by time (at most 14 days after creation).
  - Every change is recorded in the request's history and in the audit log.
- Requester can share a time-limited, revocable link with family.
- Prevent public indexing of patient details and request links.

### Discovery and maps
- Search within a configurable radius; expand gradually only when necessary.
- Show straight-line distance separately from route distance/ETA.
- Label estimates as estimates and show when location was last updated.
- Manual location and hospital selection must work without GPS permission.
- Do not expose donor exact coordinates to requesters.

### Notifications
- Respect opt-in, WhatsApp template rules, quiet hours and frequency caps.
- Deduplicate repeated alerts for the same request.
- Stop notifications when donor opts out, request closes or donor is ineligible under configured interval rules.
- Track sent, delivered, read (if available), failed and responded states.

### Admin and trust
- Verify institution identity and licence details through an auditable workflow.
- Suspend fraudulent accounts and requests.
- Provide abuse reporting, rate limits and audit logs.
- Do not publicly display personal donor lists.

## 5. Non-functional requirements
- Mobile-first responsive PWA; accessible controls and readable typography.
- API validation and consistent error format.
- Background queue for WhatsApp and matching jobs.
- Idempotent request creation and notification dispatch.
- Observability: structured logs, metrics, alerting and correlation IDs.
- Backups, restore testing and documented incident response.
- Graceful degradation if maps, WhatsApp or database services fail.

## 6. MVP exclusions
- No payments, donor incentives or sale of donor data.
- No automated diagnosis, clinical triage or compatibility determination.
- No blood inventory claims without verified source and timestamp.
- No direct blood collection, storage, transport or transfusion.
- No open public chat or unrestricted exposure of phone numbers.
- No assumption that government platforms provide unrestricted API access.

## 7. Success metrics
- Time from request creation to first valid response.
- Percentage of requests receiving at least one response.
- Percentage of requests closed with a verified outcome.
- Donor opt-out, complaint and abuse rates.
- WhatsApp delivery/failure rates.
- Institution verification turnaround.
- Location-search accuracy and stale-data rate.

## 8. Product safety copy
Display prominently: “PRANEX helps coordinate contacts. It does not guarantee donor eligibility, blood availability or compatibility. Contact the treating hospital/blood centre immediately; do not delay urgent medical care while using this app.”
