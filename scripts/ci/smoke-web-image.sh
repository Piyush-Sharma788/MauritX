#!/usr/bin/env bash
# Boots the production web image the way the server runs it and checks it is healthy.
#   scripts/ci/smoke-web-image.sh <image>
# Needs MongoDB on 127.0.0.1:27017 (the CI service container) and Docker host networking.
# Every secret is random and throwaway; WhatsApp credentials are fake, and nothing is ever sent.
set -euo pipefail
image="${1:?usage: smoke-web-image.sh <image>}"
port="${SMOKE_PORT:-3900}"
name="marutix-web-smoke-$$"
rand() { openssl rand -base64 32; }

env_file="$(mktemp)"
bad_log="$(mktemp)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -f "$env_file" "$bad_log"' EXIT
cat > "$env_file" <<ENV
NODE_ENV=production
PORT=$port
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

fail() { echo "smoke(web): FAIL: $*" >&2; docker logs "$name" 2>&1 | tail -40 >&2 || true; exit 1; }

# 1. Runs as an unprivileged user and carries no env files.
user="$(docker image inspect --format '{{.Config.User}}' "$image")"
[[ -n "$user" && "$user" != "root" && "$user" != "0" ]] || fail "image runs as root"
if docker run --rm --entrypoint sh "$image" -c 'ls -a /app | grep -E "^\.env"' >/dev/null; then fail "image contains .env files"; fi
echo "smoke(web): user=$user, no .env files"

# 2. Refuses to start with an unsafe configuration.
set +e
docker run --rm --network host -e NODE_ENV=production -e PORT="$port" -e MONGODB_URI=mongodb://127.0.0.1:27017/x \
  -e APP_BASE_URL=https://marutix.invalid -e AUTH_JWT_SECRET=short -e OTP_HASH_SECRET=short -e PII_ENCRYPTION_KEY=x "$image" >"$bad_log" 2>&1 &
bad=$!
for _ in $(seq 1 60); do kill -0 "$bad" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$bad" 2>/dev/null; then kill "$bad"; set -e; fail "started with an invalid configuration"; fi
wait "$bad"; code=$?
set -e
if [[ $code -eq 0 ]] || ! grep -q "refused to start" "$bad_log"; then fail "bad configuration didn't stop the server (exit $code)"; fi
echo "smoke(web): refuses an unsafe configuration (exit $code)"

# 3. Starts, passes its own HEALTHCHECK and answers.
docker run -d --name "$name" --network host --env-file "$env_file" "$image" >/dev/null
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)"
  [[ "$state" == "healthy" ]] && break
  [[ "$(docker inspect --format '{{.State.Running}}' "$name")" == "true" ]] || fail "container exited"
  sleep 2
done
[[ "$state" == "healthy" ]] || fail "container never became healthy ($state)"
health="$(curl -fsS "http://127.0.0.1:$port/api/health")"
[[ "$health" == '{"status":"ok","db":"up"}' ]] || fail "unexpected /api/health: $health"
headers="$(curl -fsS -o /dev/null -D - "http://127.0.0.1:$port/")"
grep -qi '^content-security-policy:' <<<"$headers" || fail "no Content-Security-Policy header"
grep -qi '^strict-transport-security:' <<<"$headers" || fail "no HSTS header"
if grep -qi '^x-powered-by:' <<<"$headers"; then fail "X-Powered-By header present"; fi
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/admin/audit")"
[[ "$code" == "401" ]] || fail "admin API answered $code without a session"
echo "smoke(web): healthy, /api/health ok with db up, security headers present, admin API requires sign-in"
