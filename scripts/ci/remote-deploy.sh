#!/usr/bin/env bash
# Runs ON the deploy host (copied there by .github/workflows/deploy.yml).
# Settings arrive on stdin as shell-quoted KEY=value lines, so the registry token never
# appears in a process list:
#   DEPLOY_PATH IMAGE_PREFIX GHCR_USER GHCR_TOKEN   always
#   IMAGE_TAG WEB_DIGEST WORKER_DIGEST              deploy
#   MODE=rollback                                   return to the previously deployed tag
#
# State in DEPLOY_PATH: .deployed-tag (current), .previous-tag, .deploy-history (append-only).
set -euo pipefail
settings="$(cat)"
eval "$settings"
MODE="${MODE:-deploy}"
cd "$DEPLOY_PATH"

printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

compose() { local tag="$1"; shift; MARUTIX_IMAGE_PREFIX="$IMAGE_PREFIX" MARUTIX_IMAGE_TAG="$tag" docker compose "$@"; }
up() { compose "$1" up -d --remove-orphans --wait --wait-timeout 240; }
record() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> .deploy-history; }

# Every service is running, every service with a healthcheck is healthy, and the
# containers run exactly the images tagged $1.
verify() {
  local tag="$1" bad=0 service state health
  while read -r service state health; do
    if [[ "$state" != "running" ]] || [[ -n "$health" && "$health" != "healthy" ]]; then
      echo "verify: $service is ${state}${health:+/$health}"; bad=1
    fi
  done < <(compose "$tag" ps -a --format '{{.Service}} {{.State}} {{.Health}}')
  for pair in web:marutix-web worker:marutix-worker jobs:marutix-worker; do
    service="${pair%%:*}"
    local want have
    want="$(docker image inspect --format '{{.Id}}' "$IMAGE_PREFIX/${pair##*:}:$tag")"
    have="$(docker inspect --format '{{.Image}}' "$(compose "$tag" ps -q "$service")" 2>/dev/null || echo none)"
    [[ "$want" == "$have" ]] || { echo "verify: $service runs $have, expected $want"; bad=1; }
  done
  return "$bad"
}

if [[ "$MODE" == "rollback" ]]; then
  previous="$(cat .previous-tag 2>/dev/null || true)"
  [[ -n "$previous" ]] || { echo "rollback: no previous deployment recorded"; exit 1; }
  echo "rollback: returning to $previous"
  compose "$previous" pull --quiet
  up "$previous" && verify "$previous"
  printf '%s\n' "$previous" > .deployed-tag
  record rollback "$previous"
  exit 0
fi

previous="$(cat .deployed-tag 2>/dev/null || true)"
echo "deploy: $IMAGE_TAG (currently ${previous:-nothing})"
compose "$IMAGE_TAG" pull --quiet

# The pulled images must be exactly the digests the pipeline verified.
for pair in "marutix-web:$WEB_DIGEST" "marutix-worker:$WORKER_DIGEST"; do
  name="${pair%%:*}"; digest="${pair#*:}"
  docker image inspect --format '{{join .RepoDigests "\n"}}' "$IMAGE_PREFIX/$name:$IMAGE_TAG" | grep -qx "$IMAGE_PREFIX/$name@$digest" \
    || { echo "deploy: pulled $name doesn't match $digest; refusing to deploy"; exit 1; }
done

if up "$IMAGE_TAG" && verify "$IMAGE_TAG"; then
  [[ -n "$previous" && "$previous" != "$IMAGE_TAG" ]] && printf '%s\n' "$previous" > .previous-tag
  printf '%s\n' "$IMAGE_TAG" > .deployed-tag
  record deploy "$IMAGE_TAG"
  docker image prune --force --filter "until=168h" >/dev/null || true
  echo "deploy: $IMAGE_TAG is running and healthy"
  exit 0
fi

echo "deploy: $IMAGE_TAG failed its health checks"
compose "$IMAGE_TAG" ps -a || true
compose "$IMAGE_TAG" logs --tail 80 || true
if [[ -n "$previous" ]]; then
  echo "deploy: rolling back to $previous"
  if up "$previous" && verify "$previous"; then record auto-rollback "$previous"; else echo "deploy: ROLLBACK ALSO FAILED; needs manual attention"; fi
fi
exit 1
