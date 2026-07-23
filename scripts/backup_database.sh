#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "${1:-}" == "--check" ]]; then
  command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
  command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
  echo "backup prerequisites: ok"
  exit 0
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
artifact="$BACKUP_DIR/synapse-${timestamp}.dump"
checksum_file="${artifact}.sha256"

pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --no-acl --file="$artifact"
if command -v shasum >/dev/null; then
  checksum="$(shasum -a 256 "$artifact" | awk '{print $1}')"
else
  checksum="$(sha256sum "$artifact" | awk '{print $1}')"
fi
printf '%s  %s\n' "$checksum" "$(basename "$artifact")" > "$checksum_file"
size_bytes="$(stat -c '%s' "$artifact" 2>/dev/null || stat -f '%z' "$artifact")"

psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --set=artifact_reference="$(basename "$artifact")" \
  --set=checksum_sha256="$checksum" \
  --set=size_bytes="$size_bytes" <<'SQL'
insert into ops.backup_runs (
  backup_type,status,artifact_reference,checksum_sha256,size_bytes,
  validation_details,finished_at
) values (
  'database','succeeded',:'artifact_reference',:'checksum_sha256',:'size_bytes'::bigint,
  jsonb_build_object('format','pg_dump-custom','checksum_verified',true),now()
);
SQL

printf '%s\n' "$artifact"
