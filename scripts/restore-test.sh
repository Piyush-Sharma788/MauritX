#!/usr/bin/env bash
# Restore drill: proves a backup can be restored and read, without touching the live database.
#
#   RESTORE_TEST_URI=mongodb://127.0.0.1:27017/marutix_restore_test scripts/restore-test.sh [archive]
#
# 1. checks the archive against its .sha256;
# 2. decrypts it if it is .enc (BACKUP_ENCRYPTION_PASSPHRASE_FILE);
# 3. restores it into the database named in RESTORE_TEST_URI (dropped first);
# 4. runs scripts/verify-restore.ts: collection counts vs the backup manifest, unique
#    indexes, and PII decryption + phone lookup with this deployment's keys;
# 5. drops the restored database (KEEP_RESTORED=1 keeps it).
#
# Without an archive argument, the newest one in BACKUP_DIR is used.
# Refuses to restore into the same database the backup came from.
# The PII keys must be in the environment (or ENV_FILE=path/to/.env), exactly as in production.
# On a Docker host without a Node checkout, set VERIFY_IMAGE to the deployed worker image.
set -euo pipefail
umask 077

: "${RESTORE_TEST_URI:?RESTORE_TEST_URI is required (a scratch database, never production)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/marutix}"
PASSFILE="${BACKUP_ENCRYPTION_PASSPHRASE_FILE:-}"
here="$(cd "$(dirname "$0")" && pwd)"

for tool in mongorestore mongosh openssl; do
  command -v "$tool" >/dev/null || { echo "restore-test: $tool is not installed" >&2; exit 2; }
done

# shellcheck disable=SC2012 # names are our own fixed pattern; ls -t gives the newest
archive="${1:-$(ls -1t "$BACKUP_DIR"/marutix-*.archive.gz "$BACKUP_DIR"/marutix-*.archive.gz.enc 2>/dev/null | head -1 || true)}"
[[ -n "$archive" && -f "$archive" ]] || { echo "restore-test: no backup archive found" >&2; exit 2; }
base="${archive%.archive.gz*}"
manifest="$base.manifest.json"
[[ -f "$manifest" ]] || { echo "restore-test: manifest $manifest is missing" >&2; exit 2; }

started=$(date +%s)
echo "restore-test: archive $(basename "$archive")"

# 1. Integrity.
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
( cd "$(dirname "$archive")" && sha256 -c "$(basename "$base").sha256" ) >/dev/null \
  || { echo "restore-test: CHECKSUM MISMATCH, archive is corrupt or was changed" >&2; exit 1; }
echo "restore-test: checksum ok"

source_db="$(sed -n 's/.*"database":"\([^"]*\)".*/\1/p' "$manifest")"
target_db="$(MARUTIX_RESTORE_URI="$RESTORE_TEST_URI" mongosh --nodb --quiet --eval 'print(connect(process.env.MARUTIX_RESTORE_URI).getName())')"
[[ -n "$source_db" && -n "$target_db" ]] || { echo "restore-test: couldn't read database names" >&2; exit 2; }
if [[ "$source_db" == "$target_db" && "${ALLOW_SAME_DB_NAME:-0}" != "1" ]]; then
  echo "restore-test: refusing to restore into \"$target_db\", the database the backup came from. Use a scratch database name." >&2
  exit 2
fi

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  if [[ "${KEEP_RESTORED:-0}" != "1" ]]; then
    MARUTIX_RESTORE_URI="$RESTORE_TEST_URI" mongosh --nodb --quiet --eval 'connect(process.env.MARUTIX_RESTORE_URI).dropDatabase()' >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
printf 'uri: "%s"\n' "$RESTORE_TEST_URI" > "$work/restore.yaml"

# 2. Decrypt.
plain="$archive"
if [[ "$archive" == *.enc ]]; then
  [[ -s "$PASSFILE" ]] || { echo "restore-test: archive is encrypted; set BACKUP_ENCRYPTION_PASSPHRASE_FILE" >&2; exit 2; }
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$PASSFILE" -in "$archive" -out "$work/plain.archive.gz" \
    || { echo "restore-test: DECRYPTION FAILED (wrong passphrase?)" >&2; exit 1; }
  plain="$work/plain.archive.gz"
  echo "restore-test: decrypted"
fi

# 3. Restore into the scratch database, renaming namespaces from the source database.
mongorestore --config="$work/restore.yaml" --archive="$plain" --gzip --drop --quiet \
  --nsInclude="$source_db.*" --nsFrom="$source_db.*" --nsTo="$target_db.*"
echo "restore-test: restored into $target_db"

# 4. Verify with the application's own crypto: from this checkout, or (VERIFY_IMAGE=<worker image>)
#    inside the deployed worker image, so the check uses exactly the code and keys in production.
if [[ -n "${VERIFY_IMAGE:-}" ]]; then
  [[ -n "${ENV_FILE:-}" ]] || { echo "restore-test: VERIFY_IMAGE needs ENV_FILE (the production env file)" >&2; exit 2; }
  docker run --rm --network host --env-file "$ENV_FILE" -e RESTORE_TEST_URI -v "$manifest:/tmp/manifest.json:ro" "$VERIFY_IMAGE" \
    node_modules/.bin/tsx --conditions=react-server scripts/verify-restore.ts /tmp/manifest.json
else
  env_args=()
  [[ -n "${ENV_FILE:-}" ]] && env_args=(--env-file="$ENV_FILE")
  ( cd "$here/.." && RESTORE_TEST_URI="$RESTORE_TEST_URI" node_modules/.bin/tsx --conditions=react-server ${env_args[@]+"${env_args[@]}"} scripts/verify-restore.ts "$manifest" )
fi

echo "restore-test: PASSED in $(( $(date +%s) - started ))s"
