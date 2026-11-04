# PRANEX

[![CI](https://github.com/Piyush-Sharma788/MauritX/actions/workflows/ci.yml/badge.svg)](https://github.com/Piyush-Sharma788/MauritX/actions/workflows/ci.yml) [![CodeQL](https://github.com/Piyush-Sharma788/MauritX/actions/workflows/codeql.yml/badge.svg)](https://github.com/Piyush-Sharma788/MauritX/actions/workflows/codeql.yml)

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

## Local setup (initial)
1. Install Node.js LTS and a package manager.
2. Create a Next.js TypeScript app.
3. Configure environment variables using `.env.example` (never commit real secrets).
4. Provision a development MongoDB database.
5. Configure a Meta WhatsApp Business Platform app and approved templates.
6. Run migrations/index setup, then start the development server.

```bash
npx create-next-app@latest pranex --typescript --tailwind --eslint --app
cd pranex
npm install mongoose zod
npm run dev
```

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
See `SETUP.md` for how to run the app and the WhatsApp worker.

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
Planning / MVP specification. This repository is not production-ready until clinical, legal, privacy, security and operational reviews are completed.
