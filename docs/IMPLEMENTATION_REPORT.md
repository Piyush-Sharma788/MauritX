# MarutiX: Final Implementation Report

Date: 5 November 2026. Covers the "Final Enhancement & Production Readiness" requirements.

**Bottom line.** Everything requested is implemented and verified on the real running application, except what needs external accounts. Real WhatsApp delivery needs Meta credentials or a linked phone. Discovery needs an identifying contact before it can be switched on. A live AI provider needs an Anthropic API key. Those are listed in §5 and §6.

---

## 1. How the work was done

Five specialised agents did the work and the coordinator integrated it:
- **Security, AI & Discovery, WhatsApp and UI/UX** worked in parallel, each owning separate folders.
- **Integration** (coordinator): shared configuration, docs, the launcher, and wiring between modules. It also reviewed every agent's changes and fixed what they left open.
- **Testing:** an independent agent that wrote none of the code tested the combined result and reported problems. The coordinator fixed them and re-verified.

---

## 2. What was implemented

### 2.1 AI-powered hospital and blood-bank discovery
- **Automatic, no manual entry.**
  - The jobs worker discovers hospitals and blood banks around every area where MarutiX has donors or requests. Areas are worked out from the database; nothing is hardcoded.
  - Each area is refreshed on a schedule. Discovery also runs per request when an admin activates one.
- **Real sources.** OpenStreetMap (Overpass + Nominatim) for name, address, phones, email, website, opening hours and blood-bank tags, plus the institution's own website (robots.txt honoured).
- **AI-assisted processing** (when `AI_PROVIDER=anthropic`): Claude extracts contacts and blood-bank evidence from website text, under these rules:
  - every value must literally appear in the page;
  - results are stored as **unverified**, with confidence and source URL;
  - AI never verifies anything or overwrites admin data.
- **Validation.** Email domains are checked for mail (DNS MX), phone numbers must be plausible Indian numbers, and websites must answer. Invalid contacts are never used for outreach.
- **Duplicates.** Records are merged on OSM reference, name similarity plus distance, or a shared phone, email or website. The merged record keeps all sources.
- **Source tracking.** Every contact and field keeps its source, URL, retrieved and last-seen dates, and a status: verified, unverified, invalid or stale. Places that disappear from the source are marked stale, never deleted.
- **Used in emergencies:**
  - outreach when a request is activated (existing);
  - the **nearest three** in the WhatsApp request confirmation;
  - a **"Nearby blood banks & hospitals"** section on the family's tracking page, with call buttons, verified places first and unverified ones clearly labelled.
- **Never delays an emergency.** The jobs worker runs three lanes (urgent / per-request discovery / background refresh), so a slow OpenStreetMap call can't hold up a donor alert.
- **Blood stock:** not available. India's e-RaktKosh has no public API and is not scraped. The system shows "unknown" and tells families to call, and a provider interface is in place for a future data source.

### 2.2 Neo-Brutalist UI redesign
- **One design system** (`src/app/globals.css`, `src/components/ui/*`):
  - thick ink borders, hard offset shadows, sharp corners (6px max);
  - bold display type with Geist Mono labels;
  - crimson / ink / paper palette with signal-yellow and mint accents, kept to AA contrast;
  - buttons that press into their shadow, a ticker and stickers on the landing page, and no motion under reduced-motion settings.
- **Applied everywhere:** public site, request flow, tracking and respond pages, sign-in and 2FA, donor portal, the whole admin area, and a new 404 page.
- **Responsive and accessible:** checked at 390 px and 1280 px with no sideways scrolling, tap targets of at least 44 px, visible focus states, and status chips that never rely on colour alone.

### 2.3 Security and production readiness
The existing security model was audited and found sound: hashed server-side sessions, OTP limits and lockout, mandatory TOTP 2FA for staff, role-based permissions, CSRF origin checks, AES-256-GCM for personal data, audit logs, and consent records. Fixes made:
- **Request bodies:** read with a hard size limit (they were previously held in memory in full), including a byte-exact limited reader for the WhatsApp webhook.
- **Audit log:** an entry whenever an admin's page or API shows donors' shared phone numbers.
- **Admin rate limits:** per-admin limits on donor matching, alert sending, test messages, WhatsApp session actions and manual discovery.
- **Admin pages:** an early redirect when there is no session cookie (`src/proxy.ts`).
- **Logs:** request IDs are no longer corrupted by redaction.
- **Route guard test:** checks that every API route has the right guard. It fails if a route is added without a classified guard.
- **Consent, verified:**
  - emergency alerts go only to donors with recorded, unwithdrawn consent, re-checked at sending time;
  - a donor's phone number is shared only after their explicit YES, and every reveal is logged.

### 2.4 WhatsApp bot
- **First contact:**
  - a designed MarutiX welcome image (`public/whatsapp/welcome.png`, rendered from `scripts/whatsapp-assets/`);
  - a friendly menu for both families and donors: 1 Need blood, 2 Become a donor, 3 Track, 4 Help;
  - the image is sent once per number, with a text fallback if it can't be sent, and never twice.
- **Conversation:** it keeps context; MENU and BACK work anywhere; a bare digit as the first message acts on that option; after three unclear replies it stops asking instead of looping.
- **Understanding:** English, Hinglish and Hindi in Devanagari, with common typos. AI (Claude) is optional and always falls back to keyword matching. Consent changes still need the exact command.
- **Speed:** replies to someone who just wrote go out right away, and multi-part replies are merged into one message. Proactive alerts keep the slower, safer pacing.
- **Reliability:**
  - duplicate and redelivered messages are ignored;
  - a send is never repeated automatically once it has started, so there are no duplicate alerts;
  - photos and voice notes get a polite reply (at most once a day);
  - every dropped message is logged with its reason.
- **START after STOP** resubscribes and shows the menu. A donor's alerts stay off until they turn them on themselves.
- **WhatsApp Web compatibility** (fixed earlier the same day): WhatsApp's hidden sender IDs (`@lid`) and its new message-ID format no longer drop messages or cause duplicates.

### 2.5 Configuration (no hardcoding)
- Every integration and limit is set through environment variables checked against a schema; `.env.example` documents each one.
- Every process validates its configuration at startup and refuses to run on a bad value.
- No hospitals, cities, coordinates or credentials are hardcoded outside tests.

### 2.6 One command
- `npm run dev` starts MongoDB (if it's local and not already running), the web app, the jobs worker and the WhatsApp worker. It prints what is running and which credentials are missing.
- Ctrl+C stops everything cleanly.
- Runtime data lives in `~/.marutix`, outside the project folder, so nothing it writes triggers a rebuild loop.

---

## 3. Verification

| Check | Result |
|---|---|
| `npm run lint`, `npm run typecheck` | Clean |
| `npm run test:integration` (real MongoDB, fake WhatsApp) | **644 / 644**, 27 files; run repeatedly, no flaky tests |
| `npm run test:e2e` (real running stack through the launcher; simulated WhatsApp senders) | **74 / 74**, including a real call to Meta's Graph API with an invalid token: Meta refused it and the message was recorded as a permanent failure, never retried or reported as sent |
| `npm run build` | Succeeds with **no warnings** |
| Independent page crawl, 390 px and 1280 px | All public, donor and admin pages: no console errors, hydration warnings, overflow or broken links |
| Black-box security tests | No auth bypass, IDOR, CSRF hole, injection, size-limit hole, or secrets in client bundles |
| Real OpenStreetMap discovery | Prayagraj 5 km: 126 places; Lucknow 5 km: 85 and 25. Duplicates merged; all labelled unverified |
| Live `npm run dev` | All services healthy, 0 rebuilds with a page open, Ctrl+C stops everything in about 4 s with nothing left running |

**Simulated vs real:** WhatsApp messages in the tests come from synthetic numbers, but they are delivered to the real webhook, signed exactly as Meta signs them, and everything after that runs for real. No message was delivered to a real phone during testing.

---

## 4. Problems found by the independent test pass, and what happened

| Issue | Status |
|---|---|
| START after STOP pushed families into donor registration | Fixed |
| Hindi in Devanagari not understood | Fixed (transliteration of common words) |
| "Nearby" card had no padding and sat at the bottom of the page | Fixed; it's now above the request controls |
| Log redaction corrupted request IDs | Fixed |
| A digit as the first message showed the menu instead of acting on it | Fixed |
| BACK on the menu said "didn't get that" | Fixed |
| Typo'd one-word commands ("reqest") not recognised | Fixed |
| "Contacted every matching donor" shown when none were found | Fixed (accurate wording) |
| 3 build warnings (whole-project tracing) | Fixed |
| `/admin` logged an error on every visit in development | Fixed (config redirect) |
| Messages sent seconds apart from one number are processed in arrival order, not WhatsApp's timestamp | Open, low impact |
| Unknown admin IDs show "This page doesn't exist" with HTTP 200 instead of 404 in development | Open, cosmetic |
| "NOT AVAILABLE" accepted as a patient's name | Open, low |
| "urgently" sets "Required by" to the moment of sending (the request stays open 24 h) | Open: product decision. Consider showing "As soon as possible" |
| With no reverse proxy, the default `TRUSTED_PROXY_HOPS=1` lets clients spoof their IP for per-IP limits | Configuration: set `TRUSTED_PROXY_HOPS` to the real number of proxies (per-number limits still apply) |

---

## 5. Remaining limitations

- **No real WhatsApp delivery has been tested.**
  - Cloud API: needs Meta credentials.
  - WhatsApp Web pilot: needs a phone that scans the QR. The pilot is unofficial and risks a ban, so use a spare number, never a personal one.
- **Production sign-in** requires the Cloud API and an approved authentication template. The development code provider is refused in production, and sign-in codes are never sent through the pilot.
- **No live blood stock data** (no public e-RaktKosh API).
- **OpenStreetMap coverage in India is thin:** about 2–3% of places have a phone and under 1% an email. Public Overpass servers are often busy; use your own `OVERPASS_URL` in production.
- **AI** (Claude intent detection and website extraction) is tested with fakes only, because no API key was configured.
- **Content Security Policy** still allows inline scripts, which Next.js needs without per-request nonces.

---

## 6. Environment variables you need to set

| Variable | Needed for | Where to get it |
|---|---|---|
| `MONGODB_URI`, `APP_BASE_URL`, `AUTH_JWT_SECRET`, `OTP_HASH_SECRET`, `PII_ENCRYPTION_KEY` | Always | Generated automatically by `npm run dev` for local use; production: MongoDB Atlas, your https domain, and `openssl rand -base64 32` |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Official WhatsApp (and production sign-in) | Meta App Dashboard (docs/WHATSAPP_BOT_GUIDE.md §7) |
| `WHATSAPP_OTP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_EMERGENCY_ALERT`, `WHATSAPP_TEMPLATE_REQUEST_CONFIRMATION` | Sign-in codes, alerts outside the 24-hour window | Approved templates (guide §8) |
| `WHATSAPP_WEB_PUBLIC_NUMBER`, `WHATSAPP_WEB_TEST_RECIPIENTS` | WhatsApp Web pilot | The linked phone's number; your own test numbers |
| `DISCOVERY_PROVIDER=openstreetmap` + `DISCOVERY_CONTACT_EMAIL` or `DISCOVERY_CONTACT_URL` | Automatic hospital discovery | A **project** contact (OpenStreetMap usage policy) |
| `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` | AI intent detection and website extraction (optional) | console.anthropic.com |
| `EMAIL_PROVIDER`, `SMTP_*`, `EMAIL_FROM` | Outreach email to hospitals (optional) | Your mail provider |
| `TRUSTED_PROXY_HOPS` | Correct client IPs behind a proxy | Number of reverse proxies (usually 1) |

New settings from this work (all with safe defaults, explained in `.env.example`):
- **WhatsApp:** `WHATSAPP_WELCOME_IMAGE_*`, `WHATSAPP_CLOUD_MEDIA_CACHE_HOURS`, `WHATSAPP_WEB_REPLY_INTERVAL_MS`.
- **Discovery:** `DISCOVERY_CONTACT_URL`, `DISCOVERY_AREA_*`, `DISCOVERY_REFRESH_DAYS`, `DISCOVERY_SWEEP_INTERVAL_MINUTES`, `DISCOVERY_REQUEST_DELAY_MS`, `DISCOVERY_BACKOFF_MINUTES`, `DISCOVERY_VALIDATE_*`, `DISCOVERY_DNS_TIMEOUT_MS`, `DISCOVERY_ENRICH_*`, `DISCOVERY_WEBSITE_TIMEOUT_MS`, `DISCOVERY_AI_*`, `DISCOVERY_MAX_AREAS`.
- **Blood stock:** `BLOOD_AVAILABILITY_PROVIDER`.

---

## 7. Where to read more

- `docs/WHATSAPP_BOT_GUIDE.md`: setup, conversations, discovery, troubleshooting.
- `SETUP.md`: running, scripts, production operations.
- `.env.example`: every setting.
