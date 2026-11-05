#!/usr/bin/env bash
# MarutiX logical backup: mongodump (gzip archive) + optional encryption + checksum + manifest.
#
#   MONGODB_URI=... BACKUP_DIR=/var/backups/marutix scripts/backup.sh
#
# Settings (environment):
#   MONGODB_URI                     database to back up (required; never printed)
#   BACKUP_DIR                      where archives go (default /var/backups/marutix)
#   BACKUP_RETENTION_DAYS           delete local archives older than this (default 14)
#   BACKUP_ENCRYPTION_PASSPHRASE_FILE  file holding the passphrase; when set, the archive is
#                                   encrypted (AES-256-CBC, PBKDF2) and the plain archive is never kept
#   BACKUP_OPLOG=1                  point-in-time dump (replica sets and Atlas only)
#
# Output, per run: marutix-<UTC timestamp>.archive.gz[.enc], .sha256 and .manifest.json
# (collection counts at dump time, used by scripts/restore-test.sh).
# The archive contains PII ciphertext and keyed hashes; it is useless without PII_ENCRYPTION_KEY,
# which must be backed up separately and never stored next to these files.
set -euo pipefail
umask 077

: "${MONGODB_URI:?MONGODB_URI is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/marutix}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
PASSFILE="${BACKUP_ENCRYPTION_PASSPHRASE_FILE:-}"

for tool in mongodump mongosh openssl; do
  command -v "$tool" >/dev/null || { echo "backup: $tool is not installed" >&2; exit 2; }
done
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "backup: BACKUP_RETENTION_DAYS must be a number" >&2; exit 2; }
if [[ -n "$PASSFILE" && ! -s "$PASSFILE" ]]; then echo "backup: passphrase file $PASSFILE is missing or empty" >&2; exit 2; fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$BACKUP_DIR/marutix-$stamp"
work="$(mktemp -d "$BACKUP_DIR/.work-XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The URI goes through a 0600 config file, not argv, so it never shows in `ps`.
printf 'uri: "%s"\n' "$MONGODB_URI" > "$work/dump.yaml"

# Collection counts just before the dump (exact on a quiet database; with BACKUP_OPLOG=1 the dump is consistent).
MARUTIX_BACKUP_URI="$MONGODB_URI" mongosh --nodb --quiet --eval '
  const db = connect(process.env.MARUTIX_BACKUP_URI);
  const counts = {};
  for (const name of db.getCollectionNames().sort()) counts[name] = db.getCollection(name).countDocuments({});
  print(JSON.stringify({ database: db.getName(), createdAt: new Date().toISOString(), counts }));
' > "$work/manifest.json"

# An empty database almost always means a wrong URI or database name; don't rotate good backups away for it.
if grep -q '"counts":{}' "$work/manifest.json" && [[ "${ALLOW_EMPTY_BACKUP:-0}" != "1" ]]; then
  echo "backup: the database has no collections (wrong MONGODB_URI or database name?). Set ALLOW_EMPTY_BACKUP=1 to back it up anyway." >&2
  exit 1
fi

oplog=()
[[ "${BACKUP_OPLOG:-0}" == "1" ]] && oplog=(--oplog)
mongodump --config="$work/dump.yaml" --archive="$work/dump.archive.gz" --gzip --quiet ${oplog[@]+"${oplog[@]}"}

if [[ -n "$PASSFILE" ]]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$PASSFILE" -in "$work/dump.archive.gz" -out "$work/dump.out"
  rm -f "$work/dump.archive.gz"
  out="$base.archive.gz.enc"
else
  mv "$work/dump.archive.gz" "$work/dump.out"
  out="$base.archive.gz"
fi

# Move into place only when complete, so a half-written backup is never mistaken for a good one.
mv "$work/dump.out" "$out"
mv "$work/manifest.json" "$base.manifest.json"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
( cd "$BACKUP_DIR" && sha256 "$(basename "$out")" > "$(basename "$base").sha256" )

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'marutix-*' -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/backup: pruned /'

size="$(wc -c < "$out" | tr -d ' ')"
echo "backup: ok $(basename "$out") ${size} bytes"
