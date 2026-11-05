# MarutiX WhatsApp Bot: Setup and Working Guide

This guide shows you how to set up, run, test and look after the MarutiX WhatsApp bot. It assumes you can use a terminal but have never set up WhatsApp before. Read it in order the first time.

Deeper design notes are in `WHATSAPP_BOT.md`. This guide covers practical setup and how the bot behaves day to day.

---

## Contents

1. [What the bot does](#1-what-the-bot-does)
2. [Verified status (read this first)](#2-verified-status-read-this-first)
3. [Run it locally in 5 minutes](#3-run-it-locally-in-5-minutes)
4. [Choose how to connect WhatsApp](#4-choose-how-to-connect-whatsapp)
5. [Environment variables](#5-environment-variables)
6. [Option A: WhatsApp Web pilot setup](#6-option-a-whatsapp-web-pilot-setup)
7. [Option B: Official WhatsApp Cloud API setup (Meta)](#7-option-b-official-whatsapp-cloud-api-setup-meta)
8. [Message templates](#8-message-templates)
9. [Testing](#9-testing)
10. [Production deployment](#10-production-deployment)
11. [How the bot works](#11-how-the-bot-works)
12. [Troubleshooting](#12-troubleshooting)
13. [Maintaining the bot](#13-maintaining-the-bot)

---

## 1. What the bot does

MarutiX coordinates emergency blood requests. The WhatsApp bot is how most people use it:

| Who | What they do on WhatsApp |
|---|---|
| **Donors** | Register (the only way to register), see and update their profile, pause or resume alerts, and answer emergency alerts |
| **Patients' families** | Create an emergency blood request, track it and cancel it |
| **Verified hospitals and blood banks** | Acknowledge requests and report stock (see `WHATSAPP_BOT.md` §10.6) |

The bot never decides anything medical. A licensed blood centre makes every decision about eligibility and compatibility. MarutiX staff verify each request with the hospital before any donor is alerted.

---

## 2. Verified status (read this first)

Last verified **5 November 2026**. There are two kinds of test, and they prove different things:

- **Real stack, simulated sender** (`npm run test:e2e`, 74 checks). This starts the whole application with the same launcher as `npm run dev`: web app, jobs worker, WhatsApp worker and MongoDB. Inbound WhatsApp messages are sent to the real webhook, signed exactly the way Meta signs them, but they come from the test script and from made-up phone numbers, not from real phones. Everything after the webhook is real: HTTP, signature checks, the conversation engine, the database, background jobs, the outbox, web sign-in, admin 2FA and the admin API. In phase 2, outbound messages go to Meta's real Graph API using a deliberately invalid token, which proves the call is made and that Meta's refusal is handled correctly.
- **Unit and integration tests** (`npm run test:integration`, 644 tests). These use a real MongoDB with a **fake** WhatsApp provider (stubbed `fetch` or an in-memory sender). They prove the logic, not the connection to WhatsApp.

**Not yet verified with a real phone.** No message has been delivered to a real WhatsApp account through either connection method. Section 2.2 lists what is needed.

### 2.1 Flow by flow

| Flow | Status | Evidence |
|---|---|---|
| Webhook verification handshake (GET) | **Completed** | E2E: correct token echoes the challenge; wrong token gets 403 |
| Webhook signature security (POST) | **Completed** | E2E: unsigned and forged requests get 401; events for another number are ignored |
| Incoming messages (text, location, buttons) | **Completed** (simulated sender) | E2E through the real webhook; Meta's retries (same message ID) are ignored |
| Donor registration | **Completed** (simulated sender) | E2E: full conversation; profile saved with consent and an approximate location. **Bug fixed in this pass:** replying REGISTER to "Would you like to register? YES/NO" used to repeat the question instead of starting |
| Donor commands (PROFILE, STATUS, PAUSE, RESUME, UPDATE) | **Completed** (simulated sender) | E2E plus integration tests |
| Intent detection from free text | **Completed (keywords)** / **Partial (AI)** | E2E: "Need B positive blood urgently in Prayagraj" starts a request with the blood group and city filled in. With `AI_PROVIDER=anthropic`, Claude is used instead, but that has only been tested with a fake AI provider. No API key was available |
| Emergency request on WhatsApp | **Completed** (simulated sender) | E2E: questions, summary, YES saves, request ID and tracking link sent, TRACK works |
| Admin verification and activation | **Completed** | E2E over the real admin API with OTP sign-in and TOTP 2FA |
| Donor matching and alert waves | **Completed** | E2E: the real jobs worker matched the donor and queued the alert within seconds |
| Donor reply to an alert (1–4, YES/NO) | **Completed** (simulated sender) | E2E: MORE INFO, interest, consent to share contact, family notified, duplicate ignored |
| Notifications to the family | **Completed** (simulated sender) | E2E: the family receives the donor's details after the donor consents |
| STOP / START and consent | **Completed** | E2E: opt-out recorded, consent withdrawn, queued messages cancelled, bot silent until START. START resubscribes and shows the menu (it no longer starts donor registration); a donor's alerts stay off until they turn them on |
| First-contact welcome image and menu | **Completed** (simulated sender) / **Partial** (real image delivery) | E2E: the first reply carries the image once per number; menu options 1–4, MENU, BACK, unclear-reply hints. Cloud mode really tried the image upload at Meta before falling back to text. Sending the image to a real phone needs credentials or a linked phone |
| Hindi (Devanagari) and Hinglish | **Completed (keywords)** | Tests: "मुझे खून चाहिए O+", "डोनर बनना है", "khoon chahiye B+ Lucknow mein", typos such as "reqest" |
| Unsupported messages (photos, voice notes…) | **Completed** | E2E: one polite line a day; captions are read |
| Hospital and blood-bank discovery | **Completed** (real OpenStreetMap data) / **Off** in your configuration | Real runs: 126 places around Prayagraj and 85 around Lucknow, deduplicated and labelled unverified. Needs `DISCOVERY_CONTACT_EMAIL` or `DISCOVERY_CONTACT_URL` to switch on (§11.11) |
| Delivery statuses (sent → delivered → read) | **Completed** (simulated receipts) | E2E: receipts through the real webhook update the message and never move backwards. Real receipts need a real send |
| Outbound through the WhatsApp Cloud API | **Partial** | E2E: the jobs worker really called `graph.facebook.com`; Meta answered HTTP 401 (error 190, invalid token); the message was marked failed and not retried. A successful send needs real credentials |
| Outbound through the WhatsApp Web pilot | **Partial** | Real: the worker starts Chromium, loads WhatsApp Web and produces a real pairing QR code. Sending needs a phone to scan the QR |
| Sign-in codes (OTP) by WhatsApp | **Partial** | Development codes (printed in the terminal) work end to end. Sending by WhatsApp needs an approved authentication template and has never been tried against Meta |
| `npm run dev` single command | **Completed** | Starts MongoDB, web, jobs and WhatsApp workers; reports missing credentials; Ctrl+C stops everything cleanly (checked: no processes or ports left behind) |

Nothing is classified **Broken**.

### 2.2 External blockers (things only you can do)

| Blocker | Needed for | How (section) |
|---|---|---|
| Meta app, WhatsApp Business Account and phone number | Real messages through the Cloud API | §7 |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Cloud API | §7 |
| A public **https** URL for the webhook (a tunnel locally, a domain in production) | Cloud API inbound messages | §7.6 |
| Approved templates `marutix_emergency_alert`, `marutix_request_confirmation` and an authentication template | Alerts to donors who haven't messaged in 24 h; sign-in codes by WhatsApp | §8 |
| A phone that scans the QR code, and `WHATSAPP_WEB_PUBLIC_NUMBER` | WhatsApp Web pilot | §6 |
| `ANTHROPIC_API_KEY` (optional) | AI understanding of free text | §5 |
| SMTP account (optional) | Outreach email to hospitals | §5 |

**Production cannot start without the Cloud API's sign-in setup.** In production the development OTP provider is refused, and sign-in codes are never sent through the WhatsApp Web pilot. So even a pilot deployment needs `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and an approved `WHATSAPP_OTP_TEMPLATE_NAME`.

---

## 3. Run it locally in 5 minutes

**You need:** Node.js 20.9 or newer, and MongoDB (macOS: `brew tap mongodb/brew && brew install mongodb-community`). You don't have to start MongoDB yourself.

```bash
npm install
npm run dev
```

That single command:

1. creates `.env` with freshly generated secrets, if it doesn't exist yet;
2. checks that the ports are free (3000 for the web app, 3100 for the WhatsApp worker) and tells you which program is using them if not;
3. starts MongoDB if `MONGODB_URI` points at this machine and it isn't already running (data in `~/.marutix/mongodb`, log in `~/.marutix/mongod.log`; change the folder with `MARUTIX_DATA_DIR`);
4. starts the **web app** (`[web]`), the **jobs worker** (`[jobs]`) and the **WhatsApp worker** (`[whatsapp]`, only in pilot mode);
5. waits until everything is healthy and prints a summary like this:

```text
[dev]      MarutiX is running.
[dev]        ✓ web          http://localhost:3000  (healthy, database up)
[dev]        ✓ jobs worker  coordination waves, discovery, outreach, retention
[dev]        ✓ whatsapp     WhatsApp Web pilot worker (bot, outbox, delivery receipts)
[dev]        !              link a phone: sign in as an admin, open http://localhost:3000/admin/whatsapp, press Connect and scan the QR
[dev]        ! sign-in codes are printed in the [web] log (OTP_PROVIDER=development), not sent
[dev]        ! AI           off (AI_PROVIDER=none): the bot uses commands and keyword matching
[dev]
[dev]      Needs external setup before real WhatsApp messages flow:
[dev]        - WHATSAPP_WEB_PUBLIC_NUMBER is empty: the website's "Become a donor" button has no WhatsApp number to open.
```

If a process crashes it restarts after 1, 2 and 4 seconds. If it keeps failing at startup, it's left stopped and marked **✗** in the summary, with its error shown in the lines above. **Ctrl+C** stops everything, MongoDB last.

**Sign in.** Open http://localhost:3000/login and enter any Indian mobile number. The code is printed in the terminal in a box labelled `MarutiX DEVELOPMENT OTP`. Nothing is sent to the phone.

**Become an admin.** After signing in once, in a second terminal run:

```bash
npm run admin:grant -- super_admin +91XXXXXXXXXX
```

Sign in again. You'll be asked to set up an authenticator app (Google Authenticator, 1Password and so on). Admin pages are under http://localhost:3000/admin.

---

## 4. Choose how to connect WhatsApp

MarutiX can talk to WhatsApp in two ways. Set `MESSAGING_PROVIDER` in `.env` to choose.

| | **A. WhatsApp Web pilot** (`whatsapp_web`, default) | **B. Official Cloud API** (`whatsapp_cloud`) |
|---|---|---|
| What it is | An ordinary WhatsApp number linked like WhatsApp Web, driven by a hidden Chrome (`whatsapp-web.js`) | Meta's official WhatsApp Business Platform |
| Setup time | 5 minutes: scan a QR code | A few hours to days: Meta app, number registration, template approval |
| Allowed by WhatsApp? | **No.** It's against WhatsApp's terms; the number can be banned without warning | Yes |
| Messages to people who haven't written in 24 h | Free text | Only approved templates |
| Inbound messages arrive via | The WhatsApp worker's browser session | The webhook `POST /api/v1/webhooks/whatsapp` |
| Who sends outbound messages | The WhatsApp worker | The jobs worker |
| Good for | Trying the bot with your own phones | Any real use, and production |

**Recommendation:** use A to explore on your own machine with your own phones. Use B for anything involving the public. Sign-in codes always need B (§2.2).

---

## 5. Environment variables

They live in `.env` for development and in your secret manager or `.env.production` for production. `.env.example` lists every variable with comments. **Never commit real values** (`.env*` is git-ignored) and never put secrets in `NEXT_PUBLIC_*` variables.

Generate a random secret with `openssl rand -base64 32`, or a token with `openssl rand -hex 16`.

### 5.1 Core (always required)

| Variable | Purpose | Where to get it |
|---|---|---|
| `MONGODB_URI` | Database | `mongodb://127.0.0.1:27017/marutix` locally; MongoDB Atlas → Connect → Drivers in production |
| `APP_BASE_URL` | Public address of the app. Used in links sent on WhatsApp and for request-origin checks | `http://localhost:3000` locally (use `localhost`, not `127.0.0.1`); `https://your-domain` in production |
| `AUTH_JWT_SECRET` | Keys session-token hashes | Generate (32+ characters) |
| `OTP_HASH_SECRET` | Keys sign-in code hashes | Generate; must differ from the others |
| `PII_ENCRYPTION_KEY` | Encrypts phone numbers and message text in the database. **Losing or changing it makes stored data unreadable** | `openssl rand -base64 32` (exactly 32 bytes) |
| `OTP_PROVIDER` | `development` prints codes in the terminal; `whatsapp` sends them through Meta | `development` locally; `whatsapp` in production |

### 5.2 WhatsApp: shared

| Variable | Purpose | Where to get it |
|---|---|---|
| `MESSAGING_PROVIDER` | `whatsapp_web` (pilot) or `whatsapp_cloud` | Your choice (§4) |

### 5.3 WhatsApp Cloud API (option B, and sign-in codes)

| Variable | Purpose | Where to get it |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Authorises calls to Meta | Temporary: App Dashboard → WhatsApp → API Setup (expires in 24 h). Permanent: system-user token (§7.4) |
| `WHATSAPP_PHONE_NUMBER_ID` | Which number sends. A long numeric **ID**, not the phone number | App Dashboard → WhatsApp → API Setup → "Phone number ID" |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Your WhatsApp Business Account (for reference) | Same page → "WhatsApp Business Account ID" |
| `WHATSAPP_APP_SECRET` | Verifies that webhook calls really come from Meta | App Dashboard → App settings → Basic → App secret → Show |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | A password you invent; Meta echoes it when you register the webhook | `openssl rand -hex 16`; enter the same value in Meta (§7.6). At least 16 characters |
| `WHATSAPP_GRAPH_API_VERSION` | Graph API version | Default `v26.0` |
| `WHATSAPP_OTP_TEMPLATE_NAME` | Approved authentication template for sign-in codes | Your template's name (§8.3) |
| `WHATSAPP_OTP_TEMPLATE_LANGUAGE` | Its language code | `en` (or `en_US`, matching the template) |
| `WHATSAPP_TEMPLATE_EMERGENCY_ALERT` | Approved template for alerts outside the 24-hour window | `marutix_emergency_alert` once approved (§8.1) |
| `WHATSAPP_TEMPLATE_REQUEST_CONFIRMATION` | Approved template for request confirmations outside the window | `marutix_request_confirmation` once approved (§8.2) |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Language of those two templates | `en` |
| `WHATSAPP_CLOUD_MAX_MESSAGES_PER_HOUR`, `..._MAX_REPLIES_PER_HOUR`, `..._MIN_SEND_INTERVAL_MS` | Safety pacing | Defaults: 250, 1000, 250 |

### 5.4 WhatsApp Web pilot (option A)

| Variable | Purpose | Where to get it |
|---|---|---|
| `WHATSAPP_WEB_WORKER_SECRET` | Password between the web app and the worker | Generate (32+ characters; created automatically on first `npm run dev`) |
| `WHATSAPP_WEB_WORKER_URL` | Worker control address. Must be loopback | `http://127.0.0.1:3100` |
| `WHATSAPP_WEB_SESSION_DIR` | Where the linked session is saved. **Anyone with these files controls the WhatsApp account** | `~/.marutix/whatsapp-session`. Keep it **outside the project folder** (see §12) |
| `WHATSAPP_WEB_PUBLIC_NUMBER` | The linked phone's number; the website's "Become a donor" button opens a chat with it | e.g. `+919XXXXXXXXX` |
| `WHATSAPP_WEB_TEST_RECIPIENTS` | Numbers admins may send test messages to | Your own phones, comma-separated |
| `WHATSAPP_WEB_MAX_MESSAGES_PER_HOUR` / `_MAX_REPLIES_PER_HOUR` / `_MIN_SEND_INTERVAL_MS` / `_MESSAGE_TTL_MINUTES` | Safety pacing and expiry. `MIN_SEND_INTERVAL_MS` now applies to proactive messages only | Defaults 30 / 300 / 4000 / 15 |
| `WHATSAPP_WEB_REPLY_INTERVAL_MS` | Gap between replies to someone who just wrote | `1000` |
| `WHATSAPP_WELCOME_IMAGE_ENABLED` / `_PATH` / `_URL` | First-contact welcome image (§11.3a). URL is an optional public https copy for the Cloud API | `true` / `public/whatsapp/welcome.png` / unset |
| `WHATSAPP_CLOUD_MEDIA_CACHE_HOURS` | How long an uploaded Cloud API image ID is reused | `168` |
| `WHATSAPP_WEB_NO_SANDBOX`, `PUPPETEER_EXECUTABLE_PATH` | Chromium options for Linux containers | Leave as is locally |

### 5.5 Matching, alerts and coordination

| Variable | Purpose | Default |
|---|---|---|
| `COORDINATION_AUTOSTART` | Send donor waves automatically once an admin activates a request | `true` |
| `DONOR_ZONES_KM` | Search rings, nearest first | `5,10,25,50` |
| `DONOR_WAVE_SIZE` / `DONOR_WAVE_INTERVAL_MINUTES` | Donors per wave, minutes between waves | `5` / `20` |
| `DONOR_TARGET_INTERESTED` | Stop widening when this many are interested (0 = twice the units) | `0` |
| `ALERT_BATCH_SIZE`, `ALERT_MAX_PER_REQUEST`, `ALERT_MAX_PER_DONOR_PER_DAY`, `ALERT_TTL_MINUTES` | Caps for alerts | `5`, `40`, `2`, `60` |
| `MATCH_MIN_DONATION_INTERVAL_DAYS`, `MATCH_MAX_CANDIDATES` | Matching limits | `90`, `100` |

### 5.6 AI (optional)

| Variable | Purpose | Where to get it |
|---|---|---|
| `AI_PROVIDER` | `none` (keywords only) or `anthropic` | Your choice |
| `ANTHROPIC_API_KEY` | Claude API key | https://console.anthropic.com → API Keys |
| `AI_MODEL` | Model used | Default `claude-opus-5-5` |
| `AI_TIMEOUT_MS`, `AI_MAX_CALLS_PER_NUMBER_PER_HOUR` | Limits | `10000`, `20` |

### 5.7 Other optional integrations

`EMAIL_PROVIDER` and `SMTP_*` (outreach email to hospitals), hospital and blood-bank discovery (§11.11; `DISCOVERY_*`, documented in `.env.example`), `SMS_PROVIDER=twilio` and `TWILIO_*` (SMS fallback for sign-in codes; needs DLT registration in India), and `ERROR_ALERT_WEBHOOK_URL` (error alerts to Slack). See `.env.example`.

---

## 6. Option A: WhatsApp Web pilot setup

Use a spare phone and number, not your personal WhatsApp: the number can be banned.

1. In `.env`, set:
   ```env
   MESSAGING_PROVIDER=whatsapp_web
   WHATSAPP_WEB_PUBLIC_NUMBER=+919XXXXXXXXX     # the phone you'll link
   WHATSAPP_WEB_TEST_RECIPIENTS=98XXXXXXXX      # another phone of yours
   ```
2. Run `npm run dev`. The summary shows `✓ whatsapp`.
3. Sign in and make yourself an admin (§3).
4. Open http://localhost:3000/admin/whatsapp and press **Connect**. Within a few seconds a QR code appears.
5. On the pilot phone: WhatsApp → Settings → **Linked devices** → **Link a device**, and scan the QR code. The status changes to **Connected**.
6. From another phone, send `Hi` to the pilot number. You should get the welcome message within a few seconds.
7. Optional: **Send a test message** on the same admin page sends to a number in `WHATSAPP_WEB_TEST_RECIPIENTS`. The log shows queued → sent → delivered → read.

The session is saved in `~/.marutix/whatsapp-session`, so restarts reconnect automatically. Always stop MarutiX with Ctrl+C (once) so WhatsApp closes cleanly. **Log out** on the admin page unlinks the device and deletes the files.

If Chromium is missing (`Could not find Chrome`), run `npx puppeteer browsers install chrome`.

---

## 7. Option B: Official WhatsApp Cloud API setup (Meta)

Meta renames dashboard menus from time to time. If a label below doesn't match exactly, look for the nearest equivalent.

### 7.1 Accounts you need

1. A Facebook account and a **Meta Business portfolio** (https://business.facebook.com).
2. A **Meta developer account** (https://developers.facebook.com, sign in and accept the terms).

### 7.2 Create the app

1. https://developers.facebook.com/apps → **Create app**.
2. Choose the use case **Connect with customers through WhatsApp** (or app type **Business**, then add the **WhatsApp** product).
3. Link it to your Business portfolio.
4. Open **WhatsApp → API Setup**. Meta gives you:
   - a **test phone number** you can send from immediately;
   - its **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`;
   - the **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`;
   - a **temporary access token** (expires after 24 hours) → `WHATSAPP_ACCESS_TOKEN` for a first test.
5. Under **To**, add your own mobile number as a recipient and confirm it with the code WhatsApp sends you. While the app is in development, the test number can only message numbers on this list (up to 5).

### 7.3 App secret

App Dashboard → **App settings → Basic → App secret → Show** → `WHATSAPP_APP_SECRET`. MarutiX uses it to check that every webhook call was signed by Meta. Treat it like a password.

### 7.4 Permanent access token

The temporary token stops working after a day. For anything longer:

1. https://business.facebook.com → **Settings → Users → System users → Add**. Give it a name and the **Admin** role.
2. **Assign assets**: your app (full control) and your WhatsApp account (full control).
3. **Generate token**: choose your app, then the permissions `whatsapp_business_messaging` and `whatsapp_business_management`. Choose "never expires" if offered.
4. Copy the token into `WHATSAPP_ACCESS_TOKEN`. It's shown only once.

### 7.5 Configure MarutiX

```env
MESSAGING_PROVIDER=whatsapp_cloud
WHATSAPP_ACCESS_TOKEN=EAAG...                  # §7.4
WHATSAPP_PHONE_NUMBER_ID=1234567890123456      # §7.2
WHATSAPP_BUSINESS_ACCOUNT_ID=1234567890123456
WHATSAPP_APP_SECRET=...                        # §7.3
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...              # openssl rand -hex 16
WHATSAPP_GRAPH_API_VERSION=v26.0
```

Restart `npm run dev`. The summary now shows `✓ whatsapp official Cloud API; webhook http://localhost:3000/api/v1/webhooks/whatsapp`, and the jobs worker logs `whatsapp_cloud.dispatcher_started`.

**Safer rollout:** you can set all the Cloud variables but keep `MESSAGING_PROVIDER=whatsapp_web` at first. Inbound messages then already arrive through the webhook, while outbound stays with the pilot. Switch to `whatsapp_cloud` once inbound works.

### 7.6 Webhook (how messages reach MarutiX)

Meta delivers messages by calling your server, so it needs a **public https address**.

**Locally**, use a tunnel. Either:
```bash
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
# or
ngrok http 3000                                    # prints https://<random>.ngrok-free.app
```
Leave `APP_BASE_URL=http://localhost:3000`; the tunnel is only for Meta. If you also want to open the app through the tunnel in a browser, add its hostname to `DEV_ALLOWED_ORIGINS`.

**In production** it's your domain, e.g. `https://marutix.example.org`.

Then, in the App Dashboard → **WhatsApp → Configuration → Webhook → Edit**:

| Field | Value |
|---|---|
| Callback URL | `https://<tunnel-or-domain>/api/v1/webhooks/whatsapp` |
| Verify token | Exactly your `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |

Press **Verify and save**. Meta calls `GET /api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`, and MarutiX echoes the challenge only if the token matches. Then under **Webhook fields**, **Subscribe** to **`messages`**. That one field carries both incoming messages and delivery statuses.

Check the handshake yourself (replace the values):
```bash
curl "https://<tunnel-or-domain>/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<your-token>&hub.challenge=12345"
# prints 12345. "Forbidden" means the token differs; "Not configured" means the Cloud variables aren't set.
```

### 7.7 First real test

1. From your own WhatsApp (added as a recipient in §7.2), send `Hi` to the test number.
2. Watch the terminal: `[web] ... whatsapp_cloud.webhook {"inbound":1,...}` means the message arrived; `[jobs]` then sends the reply.
3. You should receive the welcome message. Reply `REGISTER` and go through registration.
4. In http://localhost:3000/admin/whatsapp, the message log shows each reply's status moving to delivered and read.

### 7.8 Going live (real users)

Before strangers can use it:

1. **Add your real business number** (WhatsApp → API Setup → Add phone number). The number must not be in use on the normal WhatsApp app. Meta reviews the **display name**.
2. **Verify your business** in the Business portfolio (Security centre). This lifts the low starting messaging limits.
3. **Add a payment method** in WhatsApp Manager. Business-initiated (template) messages are charged.
4. **Switch the app to Live mode** in the App Dashboard. This requires a privacy policy URL; MarutiX has one at `/privacy`.
5. Get the templates approved (§8) and set their names.
6. Generate a permanent token (§7.4) and update `WHATSAPP_PHONE_NUMBER_ID` to the real number's ID.

---

## 8. Message templates

**Why templates?** On the Cloud API, MarutiX may send free text only within **24 hours** of the person's last message to MarutiX. Outside that window, Meta accepts only pre-approved templates. MarutiX handles this automatically: inside the window it sends text; outside, it uses the template for that kind of message if one is configured; otherwise it records the message as failed with `OUTSIDE_SERVICE_WINDOW`. It never forces a message through. (The WhatsApp Web pilot has no such rule.)

Create templates in **WhatsApp Manager → Message templates → Create template**. Language: English (`en`). Meta asks for sample values for each `{{n}}`. Copy the text **exactly**: MarutiX fills in the values in this order.

### 8.1 `marutix_emergency_alert` (category: Utility)

```text
MarutiX urgent blood request. Blood group: {{1}}. Component: {{2}}. Units required: {{3}}. Hospital: {{4}}, {{5}} ({{6}}). Required by: {{7}}. Ref: {{8}}.
Can you help? Reply 1 if you're interested, 2 if you're not available, 3 to be contacted later, 4 for more information, or STOP to stop alerts.
The blood centre decides donor eligibility and compatibility.
```
Sample values: `B+`, `Whole blood`, `2`, `City Hospital`, `Civil Lines, Prayagraj`, `about 3 km away`, `5 Nov 2026, 6:00 pm IST`, `MX-ABCD2345`. Set `WHATSAPP_TEMPLATE_EMERGENCY_ALERT=marutix_emergency_alert`.

### 8.2 `marutix_request_confirmation` (category: Utility)

```text
MarutiX has received your blood request {{1}}. Status: pending verification with the hospital. Track it here: {{2}}
MarutiX doesn't guarantee blood availability. In a life-threatening emergency, call 112. Reply STOP to stop messages.
```
Sample values: `MX-ABCD2345`, `https://marutix.example.org/track/abc`. Set `WHATSAPP_TEMPLATE_REQUEST_CONFIRMATION=marutix_request_confirmation`.

### 8.3 Sign-in code template (category: Authentication)

Create an **Authentication** template with the **Copy code** button (Meta writes the text for you). Give it a name such as `marutix_login_code` and set:
```env
WHATSAPP_OTP_TEMPLATE_NAME=marutix_login_code
WHATSAPP_OTP_TEMPLATE_LANGUAGE=en
OTP_PROVIDER=whatsapp
```
MarutiX puts the code in both the body and the button, as Meta requires.

Approval usually takes minutes to a day. If a template is rejected, adjust the wording slightly and resubmit, keeping the `{{n}}` order. If the order changes, `src/server/messaging/cloud-templates.ts` must change too.

---

## 9. Testing

### 9.1 Automated

| Command | What it proves | Needs |
|---|---|---|
| `npm run lint` and `npm run typecheck` | Code quality | — |
| `npm test` | Unit tests (fast, no database) | — |
| `npm run test:integration` | All 644 tests, with a real MongoDB and a **fake** WhatsApp. Drops the `marutix_test` database | MongoDB running |
| `npm run test:e2e` | The whole bot through a **real running stack** (74 checks, about 3 minutes). See below | Stop `npm run dev` first; internet for the final Meta check |

**`npm run test:e2e`** starts its own isolated copy of MarutiX with `scripts/dev.mjs`: ports 3999 and 3199, a throwaway database `marutix_e2e_<random>`, and an unlinked WhatsApp session. It then plays a donor, a patient's family and an admin:

- webhook handshake and signature checks;
- donor registration, commands and duplicate delivery;
- an emergency request from free text;
- OTP sign-in, admin role, TOTP 2FA, then verification and activation through the admin API;
- the jobs worker matching the donor and sending the alert;
- delivery receipts;
- the donor answering, the family being notified;
- STOP and START;
- then, after a restart in Cloud API mode, a real call to Meta's Graph API.

It prints every message and reply, so it doubles as a demonstration of the conversation. At the end it drops its database. `--quiet` hides the transcript; `E2E_VERBOSE=1` shows the servers' logs.

It can't reach a real person: replies stay in the outbox of an unlinked session, and in Cloud mode the token is deliberately invalid. Section 7 of the run is labelled simulated: it marks the alert as sent, because nothing really sends it, so that receipts and replies can be tested.

### 9.2 Manually with real phones

- **Pilot:** §6 steps 4–7.
- **Cloud API:** §7.7.

Then walk through the conversations in §11 with two phones: one as a donor, one as a patient's family. Use the admin pages to verify and activate the request.

---

## 10. Production deployment

### 10.1 Services

| Service | Pilot (`whatsapp_web`) | Cloud API (`whatsapp_cloud`) |
|---|---|---|
| `web`: Next.js, API and webhook | yes | yes |
| `jobs`: waves, matching, outreach, retention, **Cloud outbox** | yes | yes |
| `worker`: WhatsApp Web session (exactly **one**) | yes | **not needed** |
| MongoDB (Atlas recommended), with backups (SETUP.md) | yes | yes |

With Docker (images built by CI, see `CI_CD_SETUP.md`):
```bash
# deploy/docker-compose.prod.yml and .env.production in one directory
MARUTIX_IMAGE_PREFIX=ghcr.io/<owner> MARUTIX_IMAGE_TAG=<tag> docker compose up -d --wait            # pilot: all three
MARUTIX_IMAGE_PREFIX=ghcr.io/<owner> MARUTIX_IMAGE_TAG=<tag> docker compose up -d --wait web jobs   # Cloud API
```
Without Docker: `npm ci && npm run build`, then run `npm start`, `npm run jobs:worker:prod` and, for the pilot, `npm run whatsapp:worker:prod` under a process manager (systemd, pm2).

### 10.2 Required settings

- `NODE_ENV=production` (set by the compose file).
- `APP_BASE_URL=https://<your domain>`. Plain `http` is refused.
- A TLS reverse proxy (Caddy, Nginx) in front of port 3000, and `TRUSTED_PROXY_HOPS=1`.
- Strong, distinct secrets. Placeholder or reused secrets are refused at startup.
- `OTP_PROVIDER=whatsapp` with the Cloud API variables and `WHATSAPP_OTP_TEMPLATE_NAME` (§2.2).
- For the Cloud API: `WHATSAPP_APP_SECRET` is required; webhook URL `https://<your domain>/api/v1/webhooks/whatsapp`.
- Keep the same `PII_ENCRYPTION_KEY` forever, and back it up separately from the database.

Every process checks its configuration at startup and exits with a list of problems, so a bad setting shows up immediately in `docker compose logs`.

### 10.3 After deploying

1. `curl https://<domain>/api/health` → `{"status":"ok","db":"up"}`.
2. Run the webhook handshake `curl` from §7.6.
3. Send `Hi` from your phone and check you get a reply.
4. Admin → **Operations** shows queues, failed messages, bot metrics and AI usage.

---

## 11. How the bot works

### 11.1 The big picture

```text
                 WhatsApp user
                      │ message
        ┌─────────────┴─────────────┐
   (A) pilot                    (B) Cloud API
 WhatsApp worker            Meta → POST /api/v1/webhooks/whatsapp
 (browser session)               (signature checked: X-Hub-Signature-256)
        └─────────────┬─────────────┘
                      ▼
      Inbound pipeline  (src/server/messaging/inbound.ts)
      1. already seen this message ID? → ignore (Meta retries are harmless)
      2. more than 40 messages/hour from this number? → ignore
      3. STOP?  → opt out immediately, confirm once
      4. bot switched off by an admin? → ignore
                      ▼
      Conversation engine  (src/server/conversations/engine.ts)  → decides what to do,
      updates MongoDB, and puts replies in the OUTBOX (notification_events)
                      ▼
      Outbox dispatcher  (pilot: WhatsApp worker · Cloud: jobs worker)
      re-checks consent and opt-out right before sending, paces, caps,
      retries safe failures, never sends anything older than its expiry
                      ▼
                 WhatsApp user        ← delivery receipts flow back the same way as messages
```

Two rules hold everywhere:

1. **WhatsApp is a channel, not the record.** Everything is saved in MongoDB first.
2. **Nothing is sent directly.** Every message goes through the outbox, which re-checks consent at the moment of sending.

Message text is encrypted in the database and erased once a message is sent or fails.

### 11.2 How each message is routed

The engine checks these in order and stops at the first match:

1. **A conversation in progress** continues: registration, request, cancellation, or answering an alert. Exception: `REQUEST` always interrupts, because an emergency outranks everything else.
2. **A verified hospital or blood bank contact's** commands.
3. **Patient commands:** `REQUEST`, `TRACK`, `CANCEL`.
4. **Replies to an alert:** `1`–`4`, `INTERESTED` and similar.
5. **Donor commands** (`REGISTER`, `PROFILE`, `STATUS`, `UPDATE`, `PAUSE`, `RESUME`, `HELP`) and shared locations.
6. **Anything else is free text:** intent detection (§11.3), and if that doesn't produce a confident answer, the fallback (§11.9).

### 11.3 Intent detection (AI or keywords)

Free text such as *"my father needs 2 units of O+ blood urgently in Lucknow"* is interpreted into an **intent** (create request, track, register, pause alerts, and so on) and **details** (blood group, units, city, time).

- `AI_PROVIDER=none` (default): keyword rules in `src/server/ai/interpret.ts`. They cover English and common Hindi words (chahiye, khoon, zaroorat). Verified end to end.
- `AI_PROVIDER=anthropic`: Claude interprets the text. Phone numbers are removed and the text is limited to 500 characters before it's sent. If the AI fails or returns anything malformed, the keyword rules take over.

Safety rules, whichever is used:

- Details are kept only if they pass the same checks as typed answers, and are marked `*` in the summary for the person to check.
- The AI may only **start** a conversation or do read-only things (track, more info, help).
- Consent changes and alert answers are **never** made from a guess. *"Please stop messaging me"* gets *"Reply STOP to confirm."*

One behaviour to know: words like "urgently" or "now" set **Required by** to the time of the message, meaning "as soon as possible". The request then stays open for 24 hours (`computeExpiry`). Because this time can look as if it has already passed when a donor reads the alert, consider wording such as "As soon as possible" in a future change.

### 11.3a First contact: welcome image and menu

**Triggers:** the very first message MarutiX ever receives from a number (no earlier message, conversation or account, and not a verified hospital contact).

**What the person receives:** one message, the **welcome image** (`public/whatsapp/welcome.png`) with this text as its caption:

```text
Welcome to MarutiX 🩸 We connect patients' families with voluntary blood donors and verified hospitals.

How can we help? Reply with a number:
1. I need blood for a patient
2. I want to become a donor
3. Track my request
4. Help

You can also type what you need in your own words, in English or Hindi.
In a life-threatening emergency, call 112. Reply STOP anytime to stop messages.
```

The image goes to each number once, ever. If it can't be sent (file missing, upload refused), the same text arrives on its own; it's never sent twice. If the first message is already an emergency ("need O+ blood urgently"), the bot skips the image and starts the request straight away.

**The menu accepts:**
- `1`–`4`;
- the words REQUEST, REGISTER, TRACK, HELP;
- YES (= become a donor) and NO (closes the menu);
- Hindi number words (ek, do, teen, char);
- any free text, through intent detection.

An unclear reply brings the menu back with a hint ("Sorry, I didn't get that. Please reply 1, 2, 3 or 4…"). After 3 unclear replies the bot stops asking and says "Reply MENU whenever you'd like to see the options again", so it can't loop.

**MENU** (also OPTIONS or HOME) opens the menu from anywhere and sets the current conversation aside. **BACK** at the first question of a flow returns to the menu. A reply of 1–4 just after a donor alert counts as the alert answer, not a menu choice.

To change the image, edit `scripts/whatsapp-assets/welcome.html`, then run `node scripts/whatsapp-assets/render-welcome.mjs`; it refuses to save a design whose text overflows. Settings: `WHATSAPP_WELCOME_IMAGE_ENABLED`, `WHATSAPP_WELCOME_IMAGE_PATH`, `WHATSAPP_WELCOME_IMAGE_URL` (§5.4).

### 11.4 Donor registration

**Starts when:** someone chooses **2** in the menu, or sends `REGISTER`, `JOIN`, `START`, `DONATE`, `DONOR` or "I want to become a donor" (Hindi works too: "donor banna hai"). The website's "Become a donor" button opens WhatsApp with `REGISTER` already typed.

These replies are from a test run. Since this version, the intro and the first question arrive as one message, and the first contact shows the menu above:

```text
→ Hi
← [welcome image] Welcome to MarutiX 🩸 ... Reply with a number: 1. I need blood ... 2. I want to become a donor ...
→ 2               (REGISTER or YES work too)
← What's your name? ... (At any point, reply BACK to go back or CANCEL to stop.)
→ Asha Verma
← Thanks, Asha. What's your blood group? Reply A+, A-, B+, B-, AB+, AB-, O+ or O-, or NOT SURE ...
→ B+
← Which city do you live in?
→ Prayagraj
← Which locality or area in Prayagraj?
→ Civil Lines
← Optional: share your location so we only alert you about requests nearby. ... or reply SKIP.
  We keep it to about 1 km and never show it to anyone.
→ [shares location]
← When did you last donate blood? Reply with a date like 15-08-2025, or SKIP ...
→ skip
← Are you available to donate if someone nearby needs blood?  1. Yes, I'm available  2. Not right now
→ 1
← May MarutiX send you WhatsApp alerts about emergency blood requests near you? ...
  Reply YES to allow alerts, or NO to register without alerts.
→ yes
← Please check your details: Name / Blood group / Area / Location / Last donation / Availability / Alerts
  Reply YES to confirm, BACK to change your last answer, or RESTART to start over.
→ YES
← You're registered, Asha! ... Reply PAUSE to pause alerts, or STOP to stop all messages.
  Reply PROFILE to see your details or UPDATE to change them. ...
```

**What happens in the data:** a user and a donor profile are created. The phone number is taken from WhatsApp, never typed, and stored encrypted. The location is rounded to about 1 km. Consent to alerts is recorded with a timestamp. Saving happens only at the final YES. Invalid answers re-ask the question with a hint. Progress is saved, so a donor who comes back days later continues where they left off ("Welcome back!"). The donor can then sign in on the website with the same number.

### 11.5 Donor commands

| Send | Get |
|---|---|
| `PROFILE` | All your details, with the number masked |
| `STATUS` | Availability and alert status |
| `UPDATE` | A numbered menu; change one detail at a time with the same checks |
| `PAUSE` / `RESUME` | "Emergency alerts are paused…" / "Emergency alerts are back on." |
| `HELP` | The list of commands |
| `STOP` | §11.8 |

### 11.6 Emergency request from a family

**Starts when:** `REQUEST`, `NEED BLOOD`, `EMERGENCY`, or free text detected as a request. The bot first says to call 112 if life is in danger. It then asks only what it doesn't already know: patient's name (initials are fine), age (optional), contact person, blood group, component, units, urgency, hospital, city, locality, address, and the hospital's location (optional).

It shows a numbered summary. Reply a number to change that line, or **YES** to submit. Nothing is saved before YES. After YES:

```text
← ✅ Request MX-FG2D37VQ submitted. Status: Pending verification. Our team verifies every request with the hospital before any donor is alerted.
  Your private link to track, update or cancel (don't forward it): https://<APP_BASE_URL>/track/<token>
  Reply TRACK to check the status here, or CANCEL to cancel it.
```

If MarutiX already knows hospitals or blood banks near the hospital the family named, the confirmation also lists the **nearest three** (verified first, others marked "Unverified public listing", with phone numbers where known). The same list, with call buttons, appears on the family's tracking page. MarutiX never claims blood stock; see §11.11.

`TRACK` shows the status. `CANCEL` asks for confirmation. Only the number that created the request can cancel it. Duplicate submissions are detected.

### 11.7 From verification to donor alerts (matching and notifications)

1. **An admin verifies** the request with the hospital (Admin → Requests → Verified), then **activates** it. **No donor is ever alerted before this.**
2. Activation queues a job. The **jobs worker** picks it up within seconds and:
   - looks for nearby institutions (if discovery and email are configured);
   - starts **donor waves**: matching selects donors with the right blood group who are available, have consented, haven't opted out, haven't donated recently and haven't already been alerted for this request, ranked by distance. Requests without coordinates are matched by city;
   - alerts `DONOR_WAVE_SIZE` donors in the nearest ring (5 km, then 10, 25, 50), and every `DONOR_WAVE_INTERVAL_MINUTES` widens the search until enough donors are interested.
3. Each matched donor receives:

```text
← MARUTIX — URGENT BLOOD REQUEST
  Blood group: B+ · Component: Whole blood · Units required: 1
  Hospital: City Hospital · Location: Civil Lines, Prayagraj · Required by: ... · Ref: MX-FG2D37VQ
  Reply: 1 — I am interested · 2 — Not available · 3 — Contact me later · 4 — More information
  Reply STOP to stop all alerts. ... Final donor eligibility and compatibility will be assessed by the blood centre.
```

The patient's name and the family's number are never in an alert. Caps apply per donor per day and per request. Admins can pause all alerts (Admin → Operations), or pause, cancel or speed up waves for one request.

4. **Donor answers.** These work only for alerts that were actually delivered:

| Reply | Result |
|---|---|
| `4` | Hospital address and request status |
| `1` | "Your interest is recorded. This isn't a confirmed donation yet." Then: "May we share your first name, area and WhatsApp number … with the patient's family … ? YES or NO" |
| `YES` (after 1) | Next steps for the donor. The **family is told**: "Good news! A donor has responded… Donor name, blood group, area, contact". The coordinator is told too |
| `NO` (after 1) | The number stays private; MarutiX staff contact the donor instead |
| `2` / `3` | Recorded as not available / contact later; `2` replaces earlier interest |
| a second `1` | "We already have your reply…" (counted once) |

Coordinators then move each response forward step by step in the admin pages (contacted → hospital coordination → donation confirmed). Closing or cancelling the request stops all further alerts.

### 11.8 STOP and consent

- `STOP`, `UNSUBSCRIBE` or `STOP ALL`, at any time and even in the middle of a conversation, takes effect immediately. The number goes on the opt-out list, alert consent is withdrawn, messages already queued for it are cancelled, and exactly one confirmation is sent: *"You've been unsubscribed from MarutiX. … To come back later, reply START."*
- After STOP the bot says nothing in reply to anything else.
- `START` or `JOIN` re-subscribes. A registered donor gets their profile with **Emergency alerts: Off**. Alerts must be switched on again on purpose (`UPDATE`, option 7), because withdrawn consent is never restored silently.
- STOP works even when an admin has switched the bot off.

### 11.9 Fallback replies

- **Unknown number:** the welcome image and menu (§11.3a).
- **Known number with unclear text:** the menu, at most once a day per number, so casual chat doesn't cause reply loops; never within a day of the person saying NO. A greeting always gets the menu. With AI on, a short clarifying reply may be added if it makes no claims.
- **Invalid answer in a conversation:** the same question again with a hint (for example "Please reply 1, 2 or 3.").
- **Photos, voice notes, stickers, documents, contact cards:** one line, at most once a day: "Sorry, I can only read text messages and shared locations… Please type your message, or reply MENU to see the options." A photo or document *with a caption* is read as that caption.
- **Very long messages** are cut at 1000 characters; empty ones are ignored.
- **Every message the bot drops** (duplicate, rate-limited, group chat, unknown sender…) is logged with the reason, never the number, so nothing disappears silently.

**Speed:** a reply to someone who just wrote goes out right away, and multi-part replies are merged into one message. Proactive alerts keep the slower, safer pacing (`WHATSAPP_WEB_REPLY_INTERVAL_MS` vs `WHATSAPP_WEB_MIN_SEND_INTERVAL_MS`).

### 11.9a Intent detection in Hindi and Hinglish

The keyword classifier (used when AI is off, and as the fallback when it fails) understands common English, Hindi and Hinglish phrasings and typos, for example "khoon chahiye", "blood ki zarurat", "donor banna hai", "mera request kaha tak pahucha", "band karo". Hindi number words (ek, do, teen) count as units, "<City> mein" as the city, and abhi/turant/jaldi as "now". The safety rule is unchanged: consent changes (STOP, PAUSE, RESUME) and alert answers are never made from a guess.

### 11.10 Delivery statuses

For each outbound message the outbox records `queued → sending → sent → delivered → read`, or `failed` with a reason (`NOT_ON_WHATSAPP`, `OUTSIDE_SERVICE_WINDOW`, `REJECTED`, `EXPIRED` and so on). The status only ever moves forward. Admin → WhatsApp shows the log with masked numbers and no message text.

| Failure | What MarutiX does |
|---|---|
| Network errors, Meta 5xx, rate limits | Retried with backoff |
| Timeouts | Not retried (might be a duplicate) |
| Invalid token, bad template, window closed | Final; shown in Operations, and admins can retry safe ones |

### 11.11 Hospital and blood-bank discovery

MarutiX finds hospitals and blood banks automatically; nobody types them in.

**Sources (real data):**
- **OpenStreetMap** (Overpass + Nominatim): name, address, phones, email, website, opening hours, and blood-bank tags.
- **The institution's own website:** robots.txt is honoured; the homepage and one contact page are read for official email addresses and phone numbers.
- **AI-assisted extraction (optional, `AI_PROVIDER=anthropic`):** Claude reads the contact-relevant lines of the website and proposes contacts and blood-bank evidence. Every value must literally appear in the page text, low-confidence values are dropped, and everything is stored as **unverified** with its source URL and confidence. AI never verifies anything or overwrites what an admin set.

**When it runs** (jobs worker, in a background lane that never delays emergency work):
- **On request activation:** a search around the request's hospital, then outreach (existing behaviour).
- **Scheduled area refresh:** areas are worked out from where MarutiX has donors and requests (grid cells; no personal location is stored for this). Each area is re-searched every `DISCOVERY_REFRESH_DAYS`. Changed details are updated; places no longer listed are marked **stale**, never deleted.
- **Throttling:** OpenStreetMap is called one request at a time, `DISCOVERY_REQUEST_DELAY_MS` apart, with exponential backoff when its servers are busy.
- **Manual run:** admins can start one through `POST /api/v1/admin/institutions/discovery` (rate-limited).

**Quality controls:**
- Email domains must accept mail (DNS MX check), phones must be plausible Indian numbers, websites must answer. Invalid contacts are never used for outreach.
- **Duplicates** (same OpenStreetMap ref, similar name nearby, or shared phone/email/website) are merged into one record that keeps every source. The duplicate is kept as "merged", so history still resolves.
- Every contact and field keeps its **source, source URL, retrieved and last-seen dates, and status**: verified by admin, unverified, invalid, or stale.

**Verified vs unverified:** only an admin can verify an institution or contact (Admin → Institutions). Families see verified places first; everything else is clearly labelled "Unverified: from public listings. Call to confirm before going." Discovered email addresses are used for outreach only after admin approval, unless `OUTREACH_INCLUDE_UNREVIEWED=true`.

**Where families see it:** the WhatsApp request confirmation (nearest three) and the tracking page ("Nearby blood banks & hospitals", with call buttons).

**Limits to know:**
- **No blood stock data.** India's e-RaktKosh has no public API and MarutiX doesn't scrape it, so availability is always "unknown". Families are told to call.
- **OpenStreetMap coverage in India is thin.** In a real check of 5 km around Prayagraj (126 places), about 2–3% had a phone and under 1% an email. Expect most contacts to come from websites or admins.
- **Public Overpass servers are often busy.** Use your own `OVERPASS_URL` in production.
- **An identifying contact is required:** `DISCOVERY_CONTACT_EMAIL` or `DISCOVERY_CONTACT_URL`. Without it, discovery stays off.

To check discovery against real data without touching your database:
```bash
npx tsx --conditions=react-server --env-file=.env scripts/discovery-check.ts 25.4358 81.8463 5
```
(It writes to the throwaway database `marutix_discovery_check`. On networks with broken IPv6, prefix `NODE_OPTIONS=--dns-result-order=ipv4first`.)

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run dev`: "Port 3000 … is in use by node (pid …)" | MarutiX or another app is already running | Stop it (`kill <pid>`) or change `APP_BASE_URL`'s port |
| "MongoDB isn't running … and the mongod command isn't installed" | No local MongoDB | Install it (§3) or set `MONGODB_URI` to Atlas |
| `✗ whatsapp … NOT running` | The worker refused its configuration | Read the `[whatsapp]` error above the summary; it names the variable |
| "Another WhatsApp worker is running. Exiting." | Two workers (another terminal or server) | Only one may run; stop the other. A lease left by a crashed worker expires within about 30 seconds |
| Webhook verify fails in Meta | Token mismatch, the URL isn't public https, or the Cloud variables aren't set | Run the `curl` test in §7.6; check the tunnel is running |
| Webhook verified but no replies | Not subscribed to `messages`, wrong `WHATSAPP_PHONE_NUMBER_ID`, or the sender isn't an allowed test recipient | Check the subscription; look for `whatsapp_cloud.webhook {"ignored":1}` in `[web]` (that means a different number ID) |
| `whatsapp_cloud.webhook_bad_signature` | `WHATSAPP_APP_SECRET` is wrong | Copy it again from App settings → Basic |
| Replies fail with `REJECTED` | Invalid or expired token (Meta error 190), or a template problem | Generate a permanent token (§7.4); check the template name and language |
| Alerts fail with `OUTSIDE_SERVICE_WINDOW` | The donor hasn't written in 24 h and no template is configured | Get `marutix_emergency_alert` approved and set `WHATSAPP_TEMPLATE_EMERGENCY_ALERT` |
| Alerts not sent after activation | Alerts paused, no matching donors, or the jobs worker isn't running | Admin → Operations (paused? queued jobs?); request detail → Coordination |
| Donor's "1" gets the menu instead | The alert wasn't delivered, or it's older than the reply window | Check the alert's status in Admin → WhatsApp |
| Pilot: the QR code never appears | Chromium missing | `npx puppeteer browsers install chrome` |
| Pilot: disconnects often | WhatsApp logged out the linked device | Reconnect; consider the Cloud API |
| The terminal repeats `✓ Compiled in 2ms` / `GET /page` every second and the page keeps reloading | Something writes files inside the project folder; `next dev` treats each write as a code change. Usually `WHATSAPP_WEB_SESSION_DIR` or MongoDB data inside the project | Keep runtime data in `~/.marutix` (the default). `npm run dev` moves old `.data/` folders automatically and warns if the session folder is inside the project |
| Pilot: stuck on "connecting" after a restart | Chromium restored old WhatsApp tabs after an unclean exit, and they fight over the session | Fixed: the worker clears restored tabs before each start, and `npm run dev` lets the worker close WhatsApp itself. If it still happens, press Connect and scan again |
| Sign-in: "Couldn't send the code" | OTP template missing or not approved | §8.3; locally use `OTP_PROVIDER=development` |

**Logs** are one JSON line per event, labelled by process. Useful events: `whatsapp_cloud.webhook`, `whatsapp.inbound_processed`, `whatsapp_cloud.send_failed`, `jobs.worker.started`, `config.warning`. Numbers are masked and secrets redacted.

---

## 13. Maintaining the bot

| What | Where |
|---|---|
| Single-command launcher | `scripts/dev.mjs` |
| End-to-end check | `scripts/e2e/whatsapp-bot-e2e.ts` |
| Webhook route | `src/app/api/v1/webhooks/whatsapp/route.ts`, `src/server/messaging/cloud-webhook.ts` |
| Inbound pipeline (dedupe, rate limit, STOP) | `src/server/messaging/inbound.ts` |
| Routing | `src/server/conversations/engine.ts` |
| Donor registration and update | `src/server/conversations/onboarding-machine.ts` (pure state machine), `bot.ts` |
| Emergency request conversation | `src/server/conversations/request-machine.ts`, `src/server/requests/whatsapp.ts` |
| Alert replies | `src/server/coordination/responses.ts` |
| Matching and waves | `src/server/matching/`, `src/server/coordination/automation.ts` |
| Outbox, consent re-checks, sending | `src/server/messaging/queue.ts`, `eligibility.ts`, `dispatcher.ts` |
| Message wording | `src/server/messaging/templates.ts` and the machines above |
| Cloud API and templates | `src/server/messaging/cloud-provider.ts`, `cloud-templates.ts`, `src/lib/whatsapp/` |
| Pilot worker | `src/worker/whatsapp/` |
| AI | `src/server/ai/` |

**To change a bot message:** edit the text, then run `npm run test:integration` (many tests match on wording) and `npm run test:e2e`. If you change a message that has a Meta template (§8), resubmit the template too.

**To add a command:** add the word to the right set in `engine.ts` or `bot.ts`, handle it, and add a test in `tests/`. Then add it to `HELP_TEXT` in `templates.ts` and to §11 of this guide.

**Routine checks:** Admin → Operations weekly (failed messages, dead jobs, AI errors). Rotate the access token if it's ever exposed. Run the restore drill monthly (SETUP.md).
