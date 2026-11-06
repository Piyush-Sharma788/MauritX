#!/usr/bin/env bash
# Start the MarutiX WhatsApp bot from this Mac, connected to PRODUCTION
# (the MongoDB in .env and the live website), for as long as you need it.
#
#   npm run bot        # starts the WhatsApp worker + the jobs worker; Ctrl+C stops both
#
# - Settings come from .env, but links inside messages point at the live site.
# - Keeps the Mac awake while it runs. A MacBook with its lid closed still sleeps
#   unless it's plugged in with an external display.
# - First run, or after WhatsApp logs the session out, a QR code appears:
#   on the bot phone, WhatsApp → Linked devices → Link a device, and scan it.
# - While this isn't running, nothing is sent: alerts, sign-in codes and bot
#   replies wait (and alerts expire after ALERT_TTL_MINUTES).
set -euo pipefail
cd "$(dirname "$0")/.."

LIVE_URL="${MARUTIX_LIVE_URL:-https://maurit-x.vercel.app}"

if [ ! -f .env ]; then
  echo "No .env file in $(pwd). Copy .env.example to .env and fill it in first."
  exit 1
fi
# Only one WhatsApp worker may hold the session.
if pgrep -f "src/worker/whatsapp/main.ts" >/dev/null; then
  echo "A WhatsApp worker is already running (pid $(pgrep -f 'src/worker/whatsapp/main.ts' | head -1)). Stop it first."
  exit 1
fi

export APP_BASE_URL="$LIVE_URL"
echo "Starting the MarutiX bot for $APP_BASE_URL (database from .env). Press Ctrl+C to stop."

stop_all() {
  trap - INT TERM EXIT
  echo
  echo "Stopping the MarutiX bot..."
  kill 0 2>/dev/null || true
}
trap stop_all INT TERM EXIT

# Keep the Mac awake until this script exits.
caffeinate -dims -w $$ &

# Jobs worker: donor waves, discovery, outreach. Its lines are prefixed with [jobs].
npm run --silent jobs:worker 2>&1 | awk '{ print "[jobs] " $0; fflush() }' &

# WhatsApp worker: not prefixed, so a QR code (if one is needed) stays scannable.
npm run --silent whatsapp:worker &

wait
