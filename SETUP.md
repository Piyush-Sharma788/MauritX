# MarutiX — setup

Phase 1 covers the project foundation, the landing page, mobile-number OTP sign-in and an authenticated dashboard placeholder. Phase 2 adds the WhatsApp Web pilot (whatsapp-web.js): an admin pairing page, a single worker process, and the donor-messaging foundation. Phase 3 adds WhatsApp-first donor registration, the donor dashboard and alert preferences. Phase 4 adds emergency blood requests, tracking links and admin verification. The product, architecture, data and security rules live in `PRD.md`, `SYSTEM_DESIGN.md`, `DATABASE_SCHEMA.md`, `API_DOCUMENTATION.md`, `WHATSAPP_BOT.md` and `SECURITY_PRIVACY.md`. This file only explains how to run what has been built.

## Stack

- Next.js 16 (App Router, Cache Components), React 19, TypeScript
- Tailwind CSS v4
- MongoDB + Mongoose
- Zod for validation (shared by client and server)
- WhatsApp Business Platform Cloud API for OTP delivery
- Vitest for tests

## Prerequisites

- Node.js 20.9+ (LTS recommended) and npm
- MongoDB 7+ running locally, or a MongoDB Atlas connection string

On macOS with Homebrew:

```bash
brew tap mongodb/brew && brew install mongodb-community
brew services start mongodb-community
```

## Run locally

```bash
npm install
cp .env.example .env.local
```

Fill in the three secrets in `.env.local`. Generate each one with:

```bash
openssl rand -base64 32
```

Do this for `AUTH_JWT_SECRET`, `OTP_HASH_SECRET` and `PII_ENCRYPTION_KEY`. Then start the app:

```bash
npm run dev
```

Open **http://localhost:3000**. Use `localhost`, not `127.0.0.1`: the API rejects requests whose `Origin` doesn't match `APP_BASE_URL`.

### Signing in without WhatsApp credentials

If the `WHATSAPP_*` variables are empty, the app uses the **development OTP provider**:

- **Nothing is sent to the phone.** The code is printed in the `npm run dev` terminal inside a box labelled `MarutiX DEVELOPMENT OTP — NOT SENT VIA WHATSAPP`.
- The sign-in screen shows a "Development mode" warning so it can never be mistaken for real delivery.
- The provider refuses to run when `NODE_ENV=production`, and the app fails its environment check if it's configured there.

## Enabling real WhatsApp delivery

1. In Meta Business Manager, set up a WhatsApp Business Account and register a phone number with the Cloud API.
2. Create an **Authentication** message template with a **copy code** button, and wait for it to be approved.
3. Set these variables:

   ```env
   WHATSAPP_ACCESS_TOKEN=...        # system-user token with whatsapp_business_messaging
   WHATSAPP_PHONE_NUMBER_ID=...
   WHATSAPP_OTP_TEMPLATE_NAME=...   # the approved authentication template
   WHATSAPP_OTP_TEMPLATE_LANGUAGE=en
   OTP_PROVIDER=whatsapp            # optional; it's the default once the variables above are set
   ```

The send payload follows Meta's copy-code template format: the code is passed as both the body parameter and the URL-button parameter, sent to `graph.facebook.com/{WHATSAPP_GRAPH_API_VERSION}`. **It has not yet been tested against a live Meta account.** Do one end-to-end send with your approved template before relying on it. If delivery fails, the user sees an honest error and no session is created.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate Next route types, then run `tsc --noEmit` |
| `npm test` | Unit tests. Integration tests are skipped unless `MONGODB_URI_TEST` is set |
| `npm run whatsapp:worker` | Start the WhatsApp Web pilot worker (dev, reads `.env.local`) |
| `npm run admin:grant -- <phone>` / `admin:revoke` | Give or remove the admin role for an existing account |
| `npm run test:integration` | All tests against `mongodb://127.0.0.1:27017/marutix_test`. **This database is dropped on each run.** |

## Auth API

Every endpoint uses the response envelope from `API_DOCUMENTATION.md`: `{ data, error, meta: { requestId } }`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/auth/otp/request` | `{ "phone": "+919876543210" }`. Also accepts `98765 43210`, `09876543210` and similar |
| POST | `/api/v1/auth/otp/verify` | `{ "phone": "...", "code": "123456" }`. Sets an HttpOnly session cookie |
| POST | `/api/v1/auth/logout` | Revokes the session on the server and clears the cookie |
| GET | `/api/v1/auth/me` | The current user (masked phone only) |

`/api/auth/send-otp`, `/api/auth/verify-otp` and `/api/auth/logout` are aliases for the first three endpoints. The documented `/api/v1/...` paths are canonical.

### Security behaviour

| Area | Behaviour |
|---|---|
| OTP | 6 digits from `crypto.randomInt`. Stored only as an HMAC bound to the challenge and phone. Expires after 5 minutes. Usable once. Locked after 5 wrong attempts, counted atomically so parallel guesses can't exceed the limit. Only the newest challenge for a number is ever accepted |
| Rate limits | Send: 10 per IP per 15 min, 5 per phone per hour, plus a 30 s resend cooldown. Verify: 30 per IP per 15 min, 15 per phone per hour |
| Enumeration | The send response is identical whether or not an account exists |
| Users | Phone stored as AES-256-GCM ciphertext plus a keyed lookup token with a unique index. Concurrent first sign-ins still create exactly one account |
| Sessions | Opaque 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` and `__Host-` prefix in production). Only a keyed hash is stored. Expire after 7 days. Rotated on every sign-in |
| CSRF | Mutating endpoints reject cross-site `Origin` and `Sec-Fetch-Site` values |
| Headers | Baseline CSP, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy and Permissions-Policy, plus HSTS in production (see `next.config.ts`) |
| Audit | Auth events go to `audit_logs`. Logs and audit records never contain OTPs, tokens, full phone numbers or IP addresses |

## Code layout

```text
src/
  app/
    (public)/        landing, /get-help, /privacy
    (auth)/login     phone → OTP flow
    (donor)/dashboard
    api/v1/auth/*    route handlers (canonical)
    api/auth/*       aliases
  components/        ui/ primitives, landing/ sections, auth/ flow + OTP input
  features/auth/     Zod schemas + shared types, browser API client
  lib/               env, db, api handler, crypto, logger, WhatsApp client, phone validation, current-user DAL
  server/
    models/          users, otp_challenges, sessions, rate_limits, audit_logs
    services/        otp, session, users, rate-limit, audit
    otp-delivery/    WhatsApp + development providers
tests/               unit + MongoDB integration tests
```

## Deviations from the docs, and known limitations

- **Rate limits use MongoDB, not Redis.** `SYSTEM_DESIGN.md` puts them in Redis, but no Redis is provisioned yet. The `rate_limits` collection uses fixed windows with a TTL and is correct across instances. Swap it for Redis when `REDIS_URL` is available; the interface is in `server/services/rate-limit.ts`.
- **`AUTH_JWT_SECRET` keys session-token hashes.** No JWTs are issued, because the security doc requires revocable sessions. The variable name is kept from the README.
- **`PII_ENCRYPTION_KEY` is new.** `DATABASE_SCHEMA.md` asks for `phoneE164` to be "encrypted or tokenized where feasible", so it's stored as `phoneEncrypted` plus `phoneLookup`.
- **`sessions` and `rate_limits` are new collections.** They aren't listed in `DATABASE_SCHEMA.md` but are needed for revocation and throttling.
- **No SMS or voice fallback yet.** The PRD requires one, but no authorised provider has been chosen.
- **No device-level throttling.** Only IP and phone limits are applied.
- **IP limits trust `X-Forwarded-For`.** Deploy behind a proxy that overwrites the header, such as Vercel.
- **Every sign-in creates a `donor` role user.** Institution and admin onboarding are separate future flows.
- **The privacy notice is a draft** and has not had legal review.

---

## Phase 2: WhatsApp Web pilot (whatsapp-web.js)

> **This is a controlled pilot, not the official WhatsApp Business Platform.** whatsapp-web.js automates WhatsApp Web through Chromium. WhatsApp's terms prohibit unauthorised automation, and the linked number can be restricted or banned without notice. Use a dedicated pilot number, never a personal or business-critical one. The full decision and its controls are in `WHATSAPP_BOT.md` §2a.

### What's included

- **Worker process** (`src/worker/whatsapp/`). It owns the only whatsapp-web.js client and:
  - persists the session with `LocalAuth`, restores it after a restart, and reconnects with backoff;
  - stops QR pairing after 5 minutes and recovers a Chromium process orphaned by a crash;
  - sends queued messages one at a time, paced and capped per hour;
  - records delivery acks;
  - handles inbound STOP and HELP.
- **Admin page** (`/admin/whatsapp`, admins only). Shows the status (Connected, Connecting, Disconnected or Authentication failed), the QR code while pairing, the masked linked account and the last connect/disconnect. It has Connect, Reconnect and Disconnect controls, a test-message form and the recent message log.
- **Admin API** (`/api/v1/admin/whatsapp/*`, with aliases at `/api/whatsapp/*`). See `API_DOCUMENTATION.md`.
- **Messaging service** (`src/server/messaging/`). Functions:
  - `queueEmergencyRequestNotification` sends one alert per (request, donor) and dedupes automatically.
  - `queueDonorTextMessage` sends plain text to a consented donor.
  - `queueAdminTestMessage` queues the admin page's test message.

  All of them check consent and opt-out when queueing and again before sending. **No endpoint or broadcast uses the donor functions yet.**
- **Provider abstraction** (`MessagingProvider`). Implement it for the Cloud API to migrate later.

### Run it locally

1. **Configure.** In `.env.local`, set `WHATSAPP_WEB_WORKER_SECRET` (`openssl rand -base64 32`). Optionally set `WHATSAPP_WEB_TEST_RECIPIENTS=98XXXXXXXX` to a phone you control, so you can send test messages.
2. **Check Chromium.** Puppeteer's Chrome is used from `~/.cache/puppeteer`. npm 11+ doesn't run install scripts by default, so if it's missing run `npx puppeteer browsers install chrome`. Alternatively, set `PUPPETEER_EXECUTABLE_PATH` to a local Chrome or Chromium.
3. **Start both processes in separate terminals:**
   ```bash
   npm run dev
   npm run whatsapp:worker
   ```
4. **Make yourself an admin.** Sign in once at `/login`, then run:
   ```bash
   npm run admin:grant -- +91XXXXXXXXXX
   ```
5. **Pair the number.** Open `/admin/whatsapp` (a link also appears on your dashboard) and press **Connect**. On the pilot phone, go to WhatsApp → Settings → Linked devices → Link a device, and scan the QR.
6. **Test a send.** Use **Send a test message** to send to a number in `WHATSAPP_WEB_TEST_RECIPIENTS`, then watch the log move through queued → sent → delivered → read.

### Production notes

- Run **exactly one** worker on a long-running host (a VM, or a container with a persistent volume), not on serverless. A second worker exits with `lease_held`.
- Keep `WHATSAPP_WEB_SESSION_DIR` on an encrypted, persistent volume, and back it up only encrypted.
- Use `npm run whatsapp:worker:prod` with environment variables from your secret manager. Configure the process manager to stop the whole process group (for example systemd `KillMode=control-group`) so Chromium exits with the worker.
- On Linux containers running as root, set `WHATSAPP_WEB_NO_SANDBOX=true`.
- The worker's control port must stay on loopback. Startup fails if `WHATSAPP_WEB_WORKER_URL` is not a loopback address.

### Known limitations (Phase 2)

- **Donor consent can't be given in the app yet.** Until donor profiles ship, only `WHATSAPP_WEB_TEST_RECIPIENTS` can receive messages in practice.
- **No admin MFA.** Admin access relies on OTP sign-in plus the role check.
- **No donor broadcast or wave workflow.** This is intentionally deferred.
- **Library fragility.** WhatsApp Web updates can break whatsapp-web.js until the library is updated. The worker reports this as a failed start or a disconnect.

---

## Phase 3: WhatsApp-first donor registration

**Decision (2026-11-04):** donor registration happens entirely in the MarutiX WhatsApp bot. There is no website registration form, and registering needs no website account. The website is for viewing and managing an existing profile after phone verification.

### How donors register
1. Set `WHATSAPP_WEB_PUBLIC_NUMBER` to the paired pilot number (for example `+919XXXXXXXXX`) and rebuild or restart. Every Become a Donor button then opens `https://wa.me/<number>?text=REGISTER`. `/donate` shows the same link plus a QR code for desktop visitors. Without the setting, those buttons go to `/donate`, which says registration isn't open yet.
2. The donor sends REGISTER and answers the questions. Their number is taken from the chat.
3. On confirmation, the profile is saved to MongoDB. The number can't register twice.

Bot commands: REGISTER, STATUS, UPDATE, PAUSE, RESUME, STOP, HELP. Within a conversation: BACK, CANCEL, RESTART. See `WHATSAPP_BOT.md` §3 for the full behaviour.

### Website (profile access and management)
| Route | What it does |
|---|---|
| `/login` | OTP sign-in. Use the number you registered with on WhatsApp |
| `/dashboard` | For registered donors: profile, blood group, availability switch, alert preferences (turn on, pause, resume, stop), recent alerts. Without a profile: a link to the WhatsApp chat (or to finish a registration already in progress) |
| `/profile/edit` | Edit details and change mobile number (OTP-verified) |
| `/donate` | Explains WhatsApp registration, with the chat link and a QR code |

### Configuration
- `WHATSAPP_WEB_PUBLIC_NUMBER`: the public pilot number used for "Become a Donor".
- `WHATSAPP_WEB_MAX_REPLIES_PER_HOUR` (default 300) caps bot replies separately from proactive messages.

### Testing
`npm run test:integration` drives complete conversations through the real inbound router, bot, donor service and outbox, with WhatsApp replaced by a fake provider. It covers:
- registration, invalid answers, BACK, and resuming after a break;
- duplicate message delivery;
- STOP mid-registration, STOP blocking future alerts, and REGISTER/START after STOP;
- UPDATE, PAUSE, RESUME and STATUS;
- website access to a profile created on WhatsApp;
- queued replies while WhatsApp is disconnected.

### Open item: dashboard sign-in in production
Website sign-in reuses the Phase 1 OTP flow. In production that requires the official Cloud API (or another approved OTP provider), because OTPs are deliberately never sent through the whatsapp-web.js pilot (`WHATSAPP_BOT.md` §2a). In development the labelled development provider is used.

### Not included
- **Account deletion** (`DELETE /donors/me`). Donors can STOP all messages, but can't yet delete their profile themselves.
- **`lastDonationType`.** In the schema, but not collected.
- **Emergency requests, matching and broadcasts.** Out of scope.

---

## Phase 4: Emergency blood requests

### Requester flow (no account)
1. Homepage → **Request Blood** → `/request`.
2. A four-step form: patient & contact → blood needed → hospital & location (optional device location) → review, consent and an optional WhatsApp confirmation.
3. The confirmation screen shows the request ID (e.g. `MX-7K3Q9P2A`), the status **Pending verification**, and a **private tracking link** (`/track/<token>`) that lets the requester update or cancel.
4. On the tracking page the requester can see the status and history, report fulfilled or partially fulfilled, cancel, and create or turn off view-only family links (24 hours, 3 days or 7 days).

### Admin flow
1. **Grant admin access.** Run `npm run admin:grant -- +91…`, then sign in.
2. **Dashboard** at `/admin/requests`:
   - real counts (total, pending verification, active, partially fulfilled, fulfilled, cancelled and expired);
   - search by request ID (with or without `MX-`);
   - filters for status, blood group and city.
3. **Request page** at `/admin/requests/<ID>`:
   - patient and contact details, with every view audit-logged;
   - status actions with an optional internal note;
   - full history;
   - tracking links, with a button to turn each one off.

Allowed admin transitions:
- pending verification → verified or cancelled
- verified → active, partially fulfilled, fulfilled or cancelled
- active ↔ partially fulfilled → fulfilled or cancelled

Final states can't be changed.

### Safety behaviour
- **Verification.** Nothing is verified or fulfilled automatically. Unverified requests are clearly labelled on every screen.
- **Tracking links.** They never show the patient's name, contact details or coordinates. Admin notes stay internal.
- **Disclaimers.** Every requester screen carries the safety notice: no availability guarantee, and compatibility and transfusion are decided by the licensed blood centre.

### Testing
`npm run test:integration` covers:
- creating a request without an account, with encryption at rest;
- validation, idempotent retries, duplicate detection and rate limits;
- tracking privacy, view versus manage scope, and expired or revoked links;
- requester cancellation, admin transitions with history and audit, and automatic expiry;
- WhatsApp confirmation (offline, queued and after STOP);
- stats and filters, and the bot's reply to requesters.

### Limitations
- **Location.** No geocoding or maps provider is configured. The device location is approximate, and hospital verification is manual.
- **Retention.** No retention schedule for request records yet (pending legal advice).
- **Out of scope.** Donor matching, alerts, and hospital or blood-bank portals are later phases.
