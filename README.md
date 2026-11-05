# PRANEX

[![CI](https://github.com/Piyush-Sharma788/MauritX/actions/workflows/ci.yml/badge.svg)](https://github.com/Piyush-Sharma788/MauritX/actions/workflows/ci.yml)

**A mobile-first blood emergency coordination platform connecting patients, voluntary donors, blood banks and hospitals.**

> PRANEX coordinates communication and discovery. It does not collect, test, store, transport or certify blood, and it does not replace a licensed blood centre or a clinician.

## Vision
Reduce the time and friction involved in finding an appropriate blood donor or verified blood centre during an emergency.

## Core principles
- Emergency requests can be created without a patient account.
- Donors register once, manage their availability and control notifications.
- WhatsApp is a communication channel, not the source of truth.
- Blood banks and hospitals are verified before institutional access is enabled.
- Patient and donor contact details are shared only with appropriate consent.
- A licensed blood centre makes all final donor-eligibility, blood-screening and compatibility decisions.

## MVP scope
1. Mobile-first web app / PWA.
2. Donor registration through the WhatsApp bot (the only registration channel); donor profile access and management on the web after phone verification.
3. Patient/family emergency request creation.
4. Location-based discovery and distance estimates.
5. WhatsApp notifications to opted-in donors and verified institutions.
6. Request status tracking and secure family-share link.
7. Admin review, verification, abuse reporting and audit logs.

## Suggested stack
- Next.js (App Router), React, TypeScript
- Tailwind CSS, shadcn/ui, Framer Motion
- Node.js server runtime / Next.js Route Handlers
- MongoDB Atlas with Mongoose or the official MongoDB driver
- Zod validation
- WhatsApp Business Platform Cloud API
- Maps/geocoding provider (Google Maps or Mapbox)
- Redis-compatible store for rate limits, queues and short-lived OTP state
- Vercel or equivalent hosting; managed worker/queue for background jobs

## Local setup
1. Install Node.js LTS and MongoDB (macOS: `brew tap mongodb/brew && brew install mongodb-community`), or use a MongoDB Atlas URI.
2. Install dependencies and start everything with one command:

```bash
npm install
npm run dev
```

`npm run dev` creates `.env.local` with generated secrets on the first run, starts MongoDB if needed, then the web app, the jobs worker and the WhatsApp worker. It prints what is running and which external credentials (Meta WhatsApp, Anthropic, email) are still missing. See `docs/WHATSAPP_BOT_GUIDE.md` to connect WhatsApp.

## Environment variables (names only)
```env
MONGODB_URI=
APP_BASE_URL=
AUTH_JWT_SECRET=
OTP_HASH_SECRET=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
MAPS_API_KEY=
REDIS_URL=
PII_ENCRYPTION_KEY=
OTP_PROVIDER=
WHATSAPP_OTP_TEMPLATE_NAME=
# Phase 5: alerts, matching and optional AI (all have defaults; see .env.example)
ALERT_BATCH_SIZE=
ALERT_MAX_PER_REQUEST=
ALERT_MAX_PER_DONOR_PER_DAY=
ALERT_TTL_MINUTES=
MATCH_MIN_DONATION_INTERVAL_DAYS=
MATCH_MAX_CANDIDATES=
AI_PROVIDER=
ANTHROPIC_API_KEY=
AI_MODEL=
AI_TIMEOUT_MS=
AI_MAX_CALLS_PER_NUMBER_PER_HOUR=
# Phase 6: automated coordination, discovery and outreach email (see .env.example)
COORDINATION_AUTOSTART=
DONOR_ZONES_KM=
DONOR_WAVE_SIZE=
DONOR_WAVE_INTERVAL_MINUTES=
OUTREACH_RADIUS_KM=
OUTREACH_INCLUDE_UNREVIEWED=
DISCOVERY_PROVIDER=
DISCOVERY_CONTACT_EMAIL=
EMAIL_PROVIDER=
SMTP_HOST=
EMAIL_FROM=
COORDINATOR_CONTACT_PHONE=
# WhatsApp Web pilot (whatsapp-web.js), see WHATSAPP_BOT.md §2a
WHATSAPP_WEB_WORKER_URL=
WHATSAPP_WEB_WORKER_SECRET=
WHATSAPP_WEB_SESSION_DIR=
WHATSAPP_WEB_PUBLIC_NUMBER=
WHATSAPP_WEB_TEST_RECIPIENTS=
WHATSAPP_WEB_MAX_MESSAGES_PER_HOUR=
WHATSAPP_WEB_MAX_REPLIES_PER_HOUR=
WHATSAPP_WEB_MIN_SEND_INTERVAL_MS=
WHATSAPP_WEB_MESSAGE_TTL_MINUTES=
```
See `SETUP.md` for details and `docs/WHATSAPP_BOT_GUIDE.md` for the WhatsApp bot.

Use a secret manager in production. Do not put server secrets in `NEXT_PUBLIC_*` variables.

## Initial repository layout
```text
src/
  app/
    (public)/
    (donor)/
    (institution)/
    admin/
    api/
  components/
    ui/
    emergency/
    donor/
    maps/
  features/
    auth/
    donors/
    requests/
    institutions/
    notifications/
  lib/
    db/
    auth/
    whatsapp/
    maps/
    validation/
    security/
  server/
    services/
    repositories/
    jobs/
  types/
  middleware.ts
docs/
  PRD.md
  SYSTEM_DESIGN.md
  DATABASE_SCHEMA.md
  API_DOCUMENTATION.md
  WHATSAPP_BOT.md
  SECURITY_PRIVACY.md
```

## Development milestones
- M0: confirm legal/clinical operating model and institutional partners.
- M1: clickable mobile UI and usability testing.
- M2: donor registration, OTP and consent.
- M3: emergency request and location search.
- M4: WhatsApp workflows and delivery tracking.
- M5: verified institution portal and admin tools.
- M6: security testing, pilot and operational readiness.

## Important integration note
India's e-RaktKosh already provides blood-centre discovery and blood availability information. Treat it as a potential partner/integration, not as an API you can assume is publicly available. Obtain written permission and documented API access before integrating; do not scrape it.

## Status
- **Phases 1–6 are implemented as a pilot.** Phase 6 adds automated institution discovery and outreach, zone-wise donor waves, and patient–donor connection with consent and access logging. Earlier phases:
  - web emergency requests;
  - WhatsApp-first donor registration;
  - WhatsApp coordination for patients, donors and verified institutions;
  - deterministic matching with admin-controlled alerts;
  - an optional AI layer and an admin control centre.

  See SETUP.md for what is verified and what isn't.
- **Not production-ready.** This repository is not production-ready until clinical, legal, privacy, security and operational reviews are completed.
