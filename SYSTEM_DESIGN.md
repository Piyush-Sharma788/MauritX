# SYSTEM DESIGN — HLD

## 1. Architecture overview

```text
Mobile PWA (Next.js)
        |
        v
Next.js Route Handlers / Node.js application layer
        |
        +--> Authentication & consent service
        +--> Emergency request service
        +--> Donor matching service
        +--> Institution verification service
        +--> Location / maps adapter
        +--> Notification orchestration service
        |
        +--> MongoDB Atlas
        +--> Redis / queue (OTP limits, jobs, deduplication)
        +--> WhatsApp Business Cloud API (OTP)
        +--> WhatsApp Web pilot worker (whatsapp-web.js, see §10)
        +--> Maps / geocoding provider
        +--> Email/SMS fallback provider (optional)
```

## 2. Architectural decisions
- Start with a **modular monolith**, not microservices. Keep domain boundaries clear so modules can be extracted later.
- Keep WhatsApp, maps and SMS behind provider adapters; do not couple business logic to one vendor.
- Use a queue for matching and notification dispatch. Do not make a user wait for WhatsApp delivery before receiving a successful request response.
- MongoDB is the source of truth for requests, donor profiles, institutions and notification records.
- Redis is for ephemeral state, rate limits and queue coordination; it is not the permanent audit record.
- Use server-side authorization for every protected operation.

## 3. Main components
- **Web/PWA:** emergency form, donor portal, institution portal, admin portal.
- **Auth:** OTP issue/verify, session creation, refresh/revoke.
- **Request service:** create, update, cancel, expire and share.
- **Matching service:** filters eligible opted-in donors by configured rules and approximate location.
- **Institution service:** onboarding, document review, staff roles and verification.
- **Notification service:** templates, consent checks, throttling, delivery callbacks and retry.
- **Audit service:** append-only security and sensitive-action events.
- **Maps adapter:** geocoding, distance matrix and route estimate.

## 4. Emergency request sequence
*Phase 4 implements request creation, human verification, tracking and the optional requester confirmation. The matching and alert steps below (worker, matching and donor/institution WhatsApp alerts) are not built yet.*

```text
Requester -> Web: submit request + consent
Web -> API: POST /api/v1/requests
API -> Validation: validate payload
API -> MongoDB: create request
API -> Queue: enqueue matching job
API -> Web: return request ID + status
Worker -> Matching: find opted-in candidates
Matching -> MongoDB: query donors / institutions
Worker -> Consent: check notification permission and limits
Worker -> WhatsApp: send approved template
WhatsApp -> Webhook: delivery status / reply
Webhook -> API: verify signature and process event
API -> MongoDB: update notification / response state
```

## 5. Donor matching (initial policy)
1. Match requested component and blood group using a clinically reviewed compatibility policy. Do not invent universal compatibility rules in application code.
2. Exclude paused, opted-out, unverified or blocked donors.
3. Apply the configured minimum interval using last donation date and the donor's relevant category only where collected lawfully and necessary.
4. Rank by distance and last location update.
5. Notify in small waves (for example, nearest cohort first), then expand if needed.
6. Stop matching and notifications when request is closed, expired or fulfilled.
7. Let the blood centre make the final eligibility and compatibility decision.

## 6. Geospatial approach
- Store donor location as GeoJSON Point `[longitude, latitude]` and create a `2dsphere` index.
- Store only the precision required for matching; prefer approximate/coarsened coordinates.
- Keep patient exact location private and disclose it only when needed and consented.
- Calculate straight-line distance for candidate filtering; call a route provider only for the small set shown to the requester.
- Never claim that straight-line distance is driving distance or ETA.

## 7. Reliability and scaling
- Use idempotency keys for request creation and notification jobs.
- Retry transient provider errors with exponential backoff and a maximum retry count.
- Use a dead-letter queue for exhausted jobs.
- Add indexes for request status/expiry, donor blood group/availability and geospatial search.
- Use pagination and bounded search radius.
- Monitor queue lag, webhook failures, provider errors, API latency and database health.
- Test backup restoration, not just backup creation.

## 8. Failure behaviour
- GPS denied: allow manual address, locality or hospital selection.
- WhatsApp unavailable: show request status in web app; use an opted-in fallback channel if configured.
- Maps unavailable: show address and approximate distance only if calculable; label it.
- No donor matches: show verified blood-centre contacts and advise immediate hospital coordination.
- Database outage: fail safely; never display old request state as current without a stale-data warning.

## 9. Trust boundaries
Treat browser input, WhatsApp messages, map results, uploaded documents and webhook payloads as untrusted. Verify provider signatures, validate schemas, escape output and enforce role checks at the server.

## 10. WhatsApp Web pilot worker
A pilot exception (WHATSAPP_BOT.md §2a). It runs as a separate long-lived Node process (`npm run whatsapp:worker`), never inside Next.js route handlers.

```text
Admin UI -> Next.js /api/v1/admin/whatsapp/* (session + admin role check)
   |  status: read whatsapp_connection (MongoDB)
   |  qr/connect/logout: HTTP to worker on loopback, Bearer WHATSAPP_WEB_WORKER_SECRET
   v
Worker process
   +--> MongoDB lease (single session owner) + heartbeat every 10 s
   +--> whatsapp-web.js Client + LocalAuth (Chromium via Puppeteer)
   +--> Outbox dispatcher: notification_events (queued -> sending -> sent/failed/suppressed)
   +--> Inbound: dedupe (whatsapp_inbound_messages) -> per-number rate limit -> STOP -> donor bot
        (state machine + whatsapp_conversations) -> donor service -> bot replies via the outbox
Domain code -> queue functions (consent checks) -> notification_events
```

- **Provider abstraction.** `MessagingProvider` is implemented by the worker's session manager. A Cloud API provider can replace it without changing the queue, consent or dispatch logic.
- **Status.** The worker writes connection state to `whatsapp_connection`. The API reports "worker offline" when the heartbeat is older than 30 s.
- **Resilience.**
  - The worker auto-reconnects with exponential backoff (5 s up to 5 min) when a paired session drops.
  - It restores the saved session on restart.
  - It reaps a Chromium process orphaned by a crash, after verifying its profile path.
  - It stops QR pairing after 5 minutes.
- **Hosting.** The worker needs a persistent filesystem and a long-running host (a VM or container with a volume), not serverless. Run exactly one instance. Configure the process manager to kill the whole process group (for example systemd `KillMode=control-group`).

## 11. Donor module (WhatsApp-first)
- **Registration channel.** Registration happens only in the WhatsApp bot. The website's Become a Donor button deep-links to the chat (`wa.me/<WHATSAPP_WEB_PUBLIC_NUMBER>?text=REGISTER`). The website is for profile access and management after OTP sign-in to the same number.
- **Donor service** (`src/server/donors/service.ts`): it creates profiles (called only by the bot) and handles profile edits, availability, alert preferences and phone change (called by both the bot and the web API). It writes `donor_profiles`, `users.displayName`, `consent_records` and audit logs, and has no WhatsApp-specific logic.
- **WhatsApp bot** (`src/server/conversations/`): a pure state machine (registration and update flows), a persistence layer and an orchestrator that calls the donor service. It runs inside the existing worker; no extra WhatsApp client.
- **Outbox priorities.** Conversational replies (priority 0) are sent before proactive messages and have their own hourly cap (`WHATSAPP_WEB_MAX_REPLIES_PER_HOUR`, default 300), so the proactive cap (default 30) can't stall registrations.

## 12. Emergency request module (Phase 4)
- **Service** (`src/server/requests/`): creation, tracking, requester actions, admin management and lazy expiry. Status rules live in `status.ts`, which is pure and tested.
- **Creation is synchronous**, with no queue, because no matching runs yet:
  1. Idempotency replay.
  2. Duplicate check (keyed hash).
  3. Rate limits.
  4. Encrypted insert.
  5. Manage link.
  6. Optional view link and confirmation.
- **Tracking links.** Bearer URLs `/track/<token>`, sent with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. API calls send the token in `X-Tracking-Token`.
- **Expiry.** Applied on every read path with a single `updateMany` that writes a `system` history entry. No cron is needed for correctness.
- **Notifications** (`notifications.ts`): only the requester's own confirmation, queued through the existing outbox as `request_confirmation`, and only if they ask for it and WhatsApp is connected at that moment. The message carries a view-only link. There is no donor matching or broadcasting.
- **Bot awareness.** A number with an open request that messages the bot gets a request-aware reply rather than the donor sign-up.
