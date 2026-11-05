#!/usr/bin/env bash
# Checks the worker image (WhatsApp pilot worker + jobs worker + operator scripts).
#   scripts/ci/smoke-worker-image.sh <image>
# Needs MongoDB on 127.0.0.1:27017 and Docker host networking. Throwaway secrets only.
set -euo pipefail
image="${1:?usage: smoke-worker-image.sh <image>}"
name="marutix-jobs-smoke-$$"
rand() { openssl rand -base64 32; }
env_file="$(mktemp)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -f "$env_file"' EXIT
fail() { echo "smoke(worker): FAIL: $*" >&2; docker logs "$name" 2>&1 | tail -40 >&2 || true; exit 1; }

user="$(docker image inspect --format '{{.Config.User}}' "$image")"
[[ -n "$user" && "$user" != "root" && "$user" != "0" ]] || fail "image runs as root"
docker run --rm --entrypoint sh "$image" -c '
  set -e
  chromium --version
  node_modules/.bin/tsx --version >/dev/null
  test -f scripts/admin-role.ts && test -f scripts/verify-restore.ts
  ! ls -a /app | grep -E "^\.env"
' || fail "image is missing Chromium, tsx or the operator scripts (or contains .env files)"
echo "smoke(worker): user=$user, Chromium, tsx and operator scripts present"

# The jobs worker refuses an unsafe configuration...
set +e
out="$(docker run --rm --network host -e NODE_ENV=production -e MONGODB_URI=mongodb://127.0.0.1:27017/x -e APP_BASE_URL=https://marutix.invalid \
  -e AUTH_JWT_SECRET=short -e OTP_HASH_SECRET=short -e PII_ENCRYPTION_KEY=x "$image" node_modules/.bin/tsx --conditions=react-server src/worker/jobs/main.ts 2>&1)"
code=$?
set -e
if [[ $code -eq 0 ]] || ! grep -q "refused to start" <<<"$out"; then fail "jobs worker accepted an invalid configuration (exit $code)"; fi
echo "smoke(worker): jobs worker refuses an unsafe configuration (exit $code)"

# ...and with a valid one connects, starts, and shuts down cleanly on SIGTERM.
cat > "$env_file" <<ENV
NODE_ENV=production
MONGODB_URI=mongodb://127.0.0.1:27017/marutix_image_smoke
APP_BASE_URL=https://marutix.invalid
AUTH_JWT_SECRET=$(rand)
OTP_HASH_SECRET=$(rand)
PII_ENCRYPTION_KEY=$(rand)
OTP_PROVIDER=whatsapp
WHATSAPP_ACCESS_TOKEN=ci-fake-token
WHATSAPP_PHONE_NUMBER_ID=000000000000000
WHATSAPP_OTP_TEMPLATE_NAME=ci_fake_template
MESSAGING_PROVIDER=whatsapp_web
WHATSAPP_WEB_WORKER_SECRET=$(rand)
TRUSTED_PROXY_HOPS=0
ENV
docker run -d --name "$name" --network host --env-file "$env_file" "$image" node_modules/.bin/tsx --conditions=react-server src/worker/jobs/main.ts >/dev/null
for _ in $(seq 1 60); do
  docker logs "$name" 2>&1 | grep -q '"event":"jobs.worker.started"' && break
  [[ "$(docker inspect --format '{{.State.Running}}' "$name")" == "true" ]] || fail "jobs worker exited"
  sleep 1
done
docker logs "$name" 2>&1 | grep -q '"event":"jobs.worker.started"' || fail "jobs worker never started"
docker stop --time 20 "$name" >/dev/null
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" == "0" ]] || fail "jobs worker didn't exit cleanly on SIGTERM"
echo "smoke(worker): jobs worker started against MongoDB and stopped cleanly"
